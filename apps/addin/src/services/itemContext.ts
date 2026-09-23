/**
 * ItemContextService — "which email (and which surface) is the pane about,
 * right now?"
 *
 * The single source of truth for the pane's item context, and the service
 * behind the pane's hot reload: whenever the user moves to another message in
 * Outlook, it publishes a new snapshot and everything item-bound is reloaded
 * from scratch for the new message (see `ReadMode`, keyed by `itemId`).
 *
 * It merges every signal Outlook can (or fails to) give:
 *
 *   | signal                      | source                                          |
 *   |-----------------------------|-------------------------------------------------|
 *   | `ItemChanged`               | pinned pane, another message selected           |
 *   | `SelectedItemsChanged`      | multi-selection changed                         |
 *   | `visibilitychange` / `focus`| pane shown again / focused                      |
 *   | poll (1 s, visible only)    | host item and message-list selection            |
 *   |                             | (`office/itemWatch.ts`) — the switch that       |
 *   |                             | raises nothing, or leaves `mailbox.item` stale  |
 *   | `refresh()`                 | explicit reload (UI, diagnostics, tests)        |
 *
 * Signals arriving together (Outlook often raises `ItemChanged` and
 * `SelectedItemsChanged` for one click) are coalesced into one reload. Surface
 * resolution is asynchronous (`getSelectedItemsAsync`); an answer that comes
 * back after a newer change is dropped, so a slow host can never paint an old
 * surface over a new one.
 *
 * Framework-free on purpose (plain subscribe / getSnapshot): React reads it
 * through `useItemContext()` (`useSyncExternalStore`), tests drive it directly.
 */
import { useSyncExternalStore } from "react";
import { addMailboxListener, primeMailboxEvents } from "@/office/events";
import { detectSurfaceSync, resolveSurface, type AppSurface } from "@/office/host";
import { newSelectionWatch, pollHostSelection, type SelectionWatch } from "@/office/itemWatch";
import { currentConversationId, currentItemId, currentItemSubject } from "@/office/readItem";
import { track } from "@/telemetry";

export type ItemChangeReason = "start" | "item" | "selection" | "visibility" | "focus" | "poll" | "selectionPoll" | "refresh";

export interface ItemSnapshot {
  /** Surface to render (read / compose / selection / home / brief). */
  surface: AppSurface;
  /** Id of the message the pane is about (`""` = none). Key of everything item-bound. */
  itemId: string;
  conversationId: string;
  /** Subject as the host reports it, available before the body is read. */
  subject: string;
  /** Bumped on every reload, even for the same message (re-read, same key). */
  version: number;
  /** Last signal that caused a reload. */
  reason: ItemChangeReason;
  /** `Date.now()` of the last reload. */
  changedAt: number;
}

export interface ItemContextOptions {
  /** Visible-pane check interval; `0` disables the poll. */
  pollMs?: number;
  /** Delay used to coalesce signals that arrive together. */
  coalesceMs?: number;
}

/** Reasons that re-read the item even when its id did not change. */
const ALWAYS_RELOAD: ReadonlySet<ItemChangeReason> = new Set(["item", "selection", "selectionPoll", "refresh"]);

export class ItemContextService {
  private snapshot: ItemSnapshot;
  private readonly listeners = new Set<() => void>();
  private disposers: Array<() => void> = [];
  private started = false;
  private pending: Set<ItemChangeReason> = new Set();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveSeq = 0;
  private polling = false;
  private watch: SelectionWatch = newSelectionWatch();
  private readonly pollMs: number;
  private readonly coalesceMs: number;

  constructor(options: ItemContextOptions = {}) {
    this.pollMs = options.pollMs ?? 1000;
    this.coalesceMs = options.coalesceMs ?? 30;
    this.snapshot = this.read(detectSurfaceSync(), 0, "start");
  }

  /* ------------------------------ public API ------------------------------ */

  getSnapshot = (): ItemSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Start listening to Outlook. Idempotent: the entry point calls it right
   * after `Office.onReady`, and `App` calls it again (tests render `App`
   * without the entry point).
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // The host may have moved while nobody listened (first mount, remount).
    const fresh = this.read(detectSurfaceSync(), this.snapshot.version, "start");
    if (fresh.itemId !== this.snapshot.itemId || fresh.surface !== this.snapshot.surface) this.publish({ ...fresh, version: this.snapshot.version + 1 });
    // Office handlers first: registered once for the life of the pane.
    primeMailboxEvents();
    this.disposers.push(addMailboxListener("ItemChanged", () => this.signal("item")));
    this.disposers.push(addMailboxListener("SelectedItemsChanged", () => this.signal("selection")));

    if (typeof document !== "undefined") {
      const onVisibility = () => {
        if (document.visibilityState === "visible") this.recheck("visibility");
      };
      const onFocus = () => this.recheck("focus");
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      this.disposers.push(() => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
      });
    }
    if (this.pollMs > 0 && typeof window !== "undefined") {
      void this.tick(); // first observation of the list selection = baseline
      const timer = window.setInterval(() => void this.tick(), this.pollMs);
      this.disposers.push(() => window.clearInterval(timer));
    }
    // The first synchronous guess can be refined (multi-selection vs nothing selected).
    void this.resolve(this.snapshot.version);
  }

  /** Stop listening (tests; the pane itself lives until Outlook closes it). */
  stop(): void {
    for (const d of this.disposers.splice(0)) d();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
    this.started = false;
    this.watch = newSelectionWatch();
  }

  /** Force a reload of the current item (re-read, re-resolve). */
  refresh(): void {
    this.signal("refresh");
  }

  /* ------------------------------- signals -------------------------------- */

  /** Something happened: coalesce, then reload once. */
  private signal(reason: ItemChangeReason): void {
    this.pending.add(reason);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.coalesceMs);
  }

  /** Cheap checks (focus / visibility): only reload when the host item differs. */
  private recheck(reason: ItemChangeReason): void {
    if (currentItemId() !== this.snapshot.itemId) this.signal(reason);
  }

  private flush(): void {
    this.flushTimer = undefined;
    const reasons = [...this.pending];
    this.pending.clear();
    if (!reasons.length) return;
    const itemId = currentItemId();
    const changed = itemId !== this.snapshot.itemId;
    if (!changed && !reasons.some((r) => ALWAYS_RELOAD.has(r))) return;
    const reason = reasons.find((r) => r !== "selection") ?? reasons[0]!;
    const version = this.snapshot.version + 1;
    this.publish(this.read(changed ? detectSurfaceSync() : this.snapshot.surface, version, reason));
    track("pane.itemChanged", { kind: reason, changed });
    void this.resolve(version);
    // `ItemChanged` may come with a stale `mailbox.item` (office-js#5827):
    // look at the list selection now rather than at the next poll.
    if (reasons.includes("item")) setTimeout(() => void this.tick(), 300);
  }

  /** Visible-pane safety net (see `office/itemWatch.ts`). */
  private async tick(): Promise<void> {
    if (this.polling || typeof document === "undefined" || document.visibilityState !== "visible") return;
    const surface = this.snapshot.surface;
    if (surface !== "read" && surface !== "home") return;
    this.polling = true;
    try {
      if (currentItemId() !== this.snapshot.itemId) {
        this.signal("poll");
        return;
      }
      if (await pollHostSelection(this.watch, { itemId: this.snapshot.itemId, conversationId: this.snapshot.conversationId })) this.signal("selectionPoll");
    } catch {
      /* retried at the next tick */
    } finally {
      this.polling = false;
    }
  }

  /* ------------------------------- snapshot ------------------------------- */

  private read(surface: AppSurface, version: number, reason: ItemChangeReason): ItemSnapshot {
    return { surface, itemId: currentItemId(), conversationId: currentConversationId(), subject: currentItemSubject(), version, reason, changedAt: Date.now() };
  }

  /** Refine the surface; dropped when a newer change happened meanwhile. */
  private async resolve(version: number): Promise<void> {
    const seq = ++this.resolveSeq;
    let surface: AppSurface;
    try {
      surface = await resolveSurface(detectSurfaceSync());
    } catch {
      return;
    }
    if (seq !== this.resolveSeq || version !== this.snapshot.version) return;
    if (surface !== this.snapshot.surface) this.publish({ ...this.snapshot, surface });
  }

  private publish(next: ItemSnapshot): void {
    this.snapshot = next;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a broken subscriber must not break the others */
      }
    }
  }
}

/** The pane's instance. */
export const itemContext = new ItemContextService();

/** React binding: re-renders on every published snapshot. */
export function useItemContext(service: ItemContextService = itemContext): ItemSnapshot {
  return useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
}

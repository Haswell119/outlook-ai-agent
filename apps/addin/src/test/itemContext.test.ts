/**
 * ItemContextService — the pane's hot-reload service.
 *
 * Driven here with a scriptable Office host: every way Outlook can (or fails
 * to) tell the pane that the user moved to another message must end in exactly
 * one new snapshot for the new message, and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMailboxListeners } from "@/office/events";
import { setSelectedItemOverride } from "@/office/readItem";
import { ItemContextService } from "@/services/itemContext";

const originalOffice = (globalThis as { Office?: unknown }).Office;
const ok = <T>(value: T) => ({ status: "succeeded", value });

interface Msg {
  itemId: string;
  conversationId: string;
  subject: string;
}
const A: Msg = { itemId: "AAMk-A=", conversationId: "conv-a", subject: "Email A" };
const B: Msg = { itemId: "AAMk-B=", conversationId: "conv-b", subject: "Email B" };
const C: Msg = { itemId: "AAMk-C=", conversationId: "conv-c", subject: "Email C" };

function host(initial: Msg | null) {
  const handlers: Record<string, () => void> = {};
  const state = { item: initial as Msg | null, selected: initial ? [initial] : ([] as Msg[]) };
  const mailbox = {
    get item() {
      return state.item ? { ...state.item, body: { getAsync: (_t: unknown, cb: (r: unknown) => void) => cb(ok("body")) } } : null;
    },
    addHandlerAsync: (type: string, handler: () => void, cb: (r: unknown) => void) => {
      handlers[type] = handler;
      cb(ok(undefined));
    },
    getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok(state.selected.map((m) => ({ ...m, itemType: "message", itemMode: "read" })))),
    loadItemByIdAsync: (_id: string, cb: (r: unknown) => void) => cb({ status: "failed", error: { message: "not needed" } }),
  };
  Object.defineProperty(globalThis, "Office", {
    configurable: true,
    writable: true,
    value: {
      EventType: { ItemChanged: "olkItemChanged", SelectedItemsChanged: "olkSelectedItemsChanged" },
      CoercionType: { Text: "text" },
      AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
      context: { requirements: { isSetSupported: (n: string, v: string) => n === "Mailbox" && ["1.5", "1.8", "1.13", "1.15"].includes(v) }, mailbox },
    },
  });
  return {
    state,
    /** The user clicks `m`; Outlook swaps the item and raises the events. */
    switchTo(m: Msg | null, { event = true } = {}) {
      state.item = m;
      state.selected = m ? [m] : [];
      if (event) {
        handlers.olkItemChanged?.();
        handlers.olkSelectedItemsChanged?.();
      }
    },
    fire: (name: "olkItemChanged" | "olkSelectedItemsChanged") => handlers[name]?.(),
  };
}

let service: ItemContextService;

beforeEach(() => {
  vi.useFakeTimers();
  resetMailboxListeners();
  setSelectedItemOverride(null);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  service?.stop();
  vi.useRealTimers();
  resetMailboxListeners();
  setSelectedItemOverride(null);
  Object.defineProperty(globalThis, "Office", { value: originalOffice, configurable: true, writable: true });
});

async function started(h: ReturnType<typeof host>, pollMs = 1000) {
  service = new ItemContextService({ pollMs, coalesceMs: 30 });
  const seen: string[] = [];
  service.subscribe(() => seen.push(`${service.getSnapshot().itemId}@${service.getSnapshot().version}:${service.getSnapshot().reason}`));
  service.start();
  await vi.advanceTimersByTimeAsync(50);
  return { h, seen };
}

describe("ItemContextService", () => {
  it("starts on the host's item, with its subject and conversation", async () => {
    await started(host(A));
    expect(service.getSnapshot()).toMatchObject({ surface: "read", itemId: A.itemId, subject: "Email A", conversationId: "conv-a", version: 0, reason: "start" });
  });

  it("one click in Outlook (ItemChanged + SelectedItemsChanged together) = exactly one reload", async () => {
    const { h, seen } = await started(host(A));
    h.switchTo(B);
    await vi.advanceTimersByTimeAsync(50);
    expect(service.getSnapshot()).toMatchObject({ itemId: B.itemId, subject: "Email B", version: 1, reason: "item" });
    expect(seen).toEqual([`${B.itemId}@1:item`]);
  });

  it("ItemChanged for the same message still reloads it (same key, new version)", async () => {
    const { h } = await started(host(A));
    h.fire("olkItemChanged");
    await vi.advanceTimersByTimeAsync(50);
    expect(service.getSnapshot()).toMatchObject({ itemId: A.itemId, version: 1 });
  });

  it("a switch with no event at all is caught by the visible-pane poll", async () => {
    const { h } = await started(host(A));
    h.switchTo(B, { event: false });
    await vi.advanceTimersByTimeAsync(1100);
    expect(service.getSnapshot()).toMatchObject({ itemId: B.itemId, reason: "poll" });
  });

  it("does not poll a hidden pane, and catches up when it becomes visible", async () => {
    const { h } = await started(host(A));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    h.switchTo(C, { event: false });
    await vi.advanceTimersByTimeAsync(3000);
    expect(service.getSnapshot().itemId).toBe(A.itemId);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
    expect(service.getSnapshot()).toMatchObject({ itemId: C.itemId, reason: "visibility" });
  });

  it("focus with the same message does nothing (no needless reload)", async () => {
    const { seen } = await started(host(A));
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(50);
    expect(seen).toEqual([]);
  });

  it("closing the message moves to the home surface; a multi-selection to the selection surface", async () => {
    const { h } = await started(host(A));
    h.switchTo(null);
    await vi.advanceTimersByTimeAsync(50);
    expect(service.getSnapshot()).toMatchObject({ surface: "home", itemId: "" });

    h.state.selected = [A, B];
    h.fire("olkSelectedItemsChanged");
    await vi.advanceTimersByTimeAsync(50);
    expect(service.getSnapshot().surface).toBe("selection");
  });

  it("refresh() reloads on demand; stop() detaches everything", async () => {
    const { h } = await started(host(A), 0);
    service.refresh();
    await vi.advanceTimersByTimeAsync(50);
    expect(service.getSnapshot()).toMatchObject({ version: 1, reason: "refresh" });
    service.stop();
    h.switchTo(B);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.getSnapshot().itemId).toBe(A.itemId);
  });

  it("start() after a stop picks up a message chosen while nobody listened (StrictMode remount)", async () => {
    const { h } = await started(host(A), 0);
    service.stop();
    h.switchTo(B, { event: false });
    service.start();
    expect(service.getSnapshot()).toMatchObject({ itemId: B.itemId, version: 1 });
  });
});

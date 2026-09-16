/**
 * Multi-select support: the pane opened on **several messages selected in the
 * list**, without any of them being open.
 *
 * Office.js path (new Outlook / Outlook on the web only):
 *   1. `Office.context.mailbox.getSelectedItemsAsync` (Mailbox **1.13**) returns
 *      one descriptor per selected message: `itemId`, `conversationId`,
 *      `internetMessageId`, `subject`, `itemType`, `itemMode`. It does **not**
 *      return the sender or the body.
 *   2. `Office.context.mailbox.loadItemByIdAsync` (Mailbox **1.15**) loads each
 *      descriptor into a real read item, which is then mapped by
 *      `readMessageItem` (sender, recipients, body, attachments, categories).
 *   3. When 1.15 is missing — or the host refuses a particular id — the item
 *      degrades to what step 1 gave us (subject, ids). The UI says so, and the
 *      synthesis then runs on subjects only instead of failing.
 *
 * The selection has no `conversationId` of its own, so we mint a stable one:
 * `selection:<hash of the sorted item ids>`. It is what the synthesis
 * (`analyzeThread`) is keyed and cached by, and what scopes the chat retrieval
 * after the selected items have been indexed.
 */
import type { EmailContext, ThreadContext } from "@oao/shared";
import { hashParts } from "@/util/hash";
import { asyncResult, isOfficeAvailable, isSetSupported, officeGlobal, queryParam } from "./env";
import { readMessageItem } from "./readItem";
import { cacheItem } from "./cache";
import { sampleEmail, sampleNewsletter, sampleThread } from "./sample";

/** Prefix of the synthetic conversation id minted for a selection. */
export const SELECTION_PREFIX = "selection:";

/** Upper bound on how many selected messages we load and send. */
export const MAX_SELECTED_ITEMS = 50;

/**
 * Stable, order-independent id for a set of selected messages.
 * Selecting A then B and selecting B then A must hit the same cache entry.
 */
export function selectionId(itemIds: ReadonlyArray<string>): string {
  const ids = [...new Set(itemIds.map((id) => (id ?? "").trim()).filter(Boolean))].sort();
  return `${SELECTION_PREFIX}${hashParts(ids)}`;
}

export function isSelectionId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(SELECTION_PREFIX);
}

/** What `getSelectedItemsAsync` hands back (fields beyond the docs are optional). */
export interface SelectedItemRef {
  itemId: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  itemType?: string;
  itemMode?: string;
  /** Not documented for every host; used when present. */
  from?: { displayName?: string; emailAddress?: string };
  sender?: { displayName?: string; emailAddress?: string };
}

export interface SelectionContext {
  /** `selection:<hash>` — the synthetic conversation id. */
  id: string;
  items: EmailContext[];
  /** How many items were loaded with their body (`loadItemByIdAsync`). */
  loadedCount: number;
  /** True when at least one item is subject-only (no `loadItemByIdAsync`). */
  degraded: boolean;
  /** False when the host has no `getSelectedItemsAsync` (Mailbox < 1.13). */
  supported: boolean;
}

export const EMPTY_SELECTION: SelectionContext = { id: "", items: [], loadedCount: 0, degraded: false, supported: false };

/** True when the host can tell us what is selected in the list. */
export function isMultiSelectSupported(): boolean {
  try {
    const mailbox = officeGlobal()?.context?.mailbox as unknown as { getSelectedItemsAsync?: unknown } | undefined;
    return isOfficeAvailable() && isSetSupported("Mailbox", "1.13") && typeof mailbox?.getSelectedItemsAsync === "function";
  } catch {
    return false;
  }
}

/** True when whole messages can be loaded from their id. */
export function isItemLoadSupported(): boolean {
  try {
    const mailbox = officeGlobal()?.context?.mailbox as unknown as { loadItemByIdAsync?: unknown } | undefined;
    return isOfficeAvailable() && isSetSupported("Mailbox", "1.15") && typeof mailbox?.loadItemByIdAsync === "function";
  } catch {
    return false;
  }
}

/**
 * Browser-preview test hook: `?selection=3` fakes a three-message selection so
 * the view can be reviewed (and screenshotted) without Outlook. Only ever used
 * when there is no Office host.
 */
export function previewSelectionSize(): number {
  const raw = queryParam("selection");
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 2) return 0;
  return Math.min(n, MAX_SELECTED_ITEMS);
}

function previewSelection(size: number): SelectionContext {
  const pool = [...sampleThread.messages].reverse().concat([sampleNewsletter, sampleEmail]);
  const items: EmailContext[] = [];
  for (const candidate of pool) {
    if (items.length >= size) break;
    if (items.some((i) => i.id === candidate.id)) continue;
    items.push(candidate);
  }
  return { id: selectionId(items.map((i) => i.id)), items, loadedCount: items.length, degraded: false, supported: true };
}

/** Raw selection descriptors, or `null` when the host cannot report them. */
export async function getSelectedItemRefs(): Promise<SelectedItemRef[] | null> {
  if (!isMultiSelectSupported()) return null;
  const mailbox = officeGlobal()!.context.mailbox as unknown as {
    getSelectedItemsAsync: (cb: (r: Office.AsyncResult<SelectedItemRef[]>) => void) => void;
  };
  try {
    const value = await asyncResult<SelectedItemRef[]>((cb) => mailbox.getSelectedItemsAsync(cb));
    return (value ?? []).filter((r) => !!r?.itemId);
  } catch {
    return null;
  }
}

/**
 * How many messages are selected: `0`/`1` means "use the read or home surface",
 * `> 1` means the selection view. `-1` = the host cannot tell us.
 */
export async function countSelectedItems(): Promise<number> {
  const refs = await getSelectedItemRefs();
  return refs === null ? -1 : refs.length;
}

function shallowItem(ref: SelectedItemRef): EmailContext {
  const address = ref.from?.emailAddress ?? ref.sender?.emailAddress;
  return {
    id: ref.itemId,
    conversationId: ref.conversationId || undefined,
    internetMessageId: ref.internetMessageId || undefined,
    subject: ref.subject ?? "",
    from: address ? { name: ref.from?.displayName ?? ref.sender?.displayName ?? undefined, address } : undefined,
    to: [],
    cc: [],
    bcc: [],
    body: "",
    attachments: [],
    categories: [],
  };
}

async function loadFullItem(itemId: string): Promise<EmailContext | null> {
  if (!isItemLoadSupported()) return null;
  const mailbox = officeGlobal()!.context.mailbox as unknown as {
    loadItemByIdAsync: (id: string, cb: (r: Office.AsyncResult<Office.MessageRead>) => void) => void;
  };
  try {
    const loaded = await asyncResult<Office.MessageRead>((cb) => mailbox.loadItemByIdAsync(itemId, cb));
    if (!loaded) return null;
    const email = await readMessageItem(loaded, itemId);
    return email.id ? email : { ...email, id: itemId };
  } catch {
    // A single unreadable item must not sink the whole selection.
    return null;
  }
}

/**
 * Read everything the host will tell us about the current selection.
 * Never throws: an unsupported host comes back as `supported: false`.
 */
export async function readSelectedItems(): Promise<SelectionContext> {
  if (!isOfficeAvailable()) {
    const size = previewSelectionSize();
    return size > 0 ? previewSelection(size) : EMPTY_SELECTION;
  }
  const refs = await getSelectedItemRefs();
  if (refs === null) return { ...EMPTY_SELECTION, supported: false };

  const selected = refs.slice(0, MAX_SELECTED_ITEMS);
  const id = selectionId(selected.map((r) => r.itemId));
  let loadedCount = 0;
  const items: EmailContext[] = [];
  for (const ref of selected) {
    const full = await loadFullItem(ref.itemId);
    if (full) {
      loadedCount++;
      // Feed the per-session cache so "Index recent emails" and the thread
      // fallback can see these messages too.
      cacheItem(full);
      items.push(full);
    } else {
      items.push(shallowItem(ref));
    }
  }
  return { id, items, loadedCount, degraded: loadedCount < items.length, supported: true };
}

/**
 * The selection as a `ThreadContext` the orchestrator already understands:
 * `analyzeThread` synthesises any set of messages, it does not require them to
 * belong to one real conversation.
 */
export function selectionThread(selection: SelectionContext, subject: string): ThreadContext | null {
  if (!selection.items.length) return null;
  return { conversationId: selection.id, subject, messages: selection.items };
}

/**
 * The selected messages re-keyed onto the synthetic conversation id, so that
 * `chat` with `scope.conversationId = selection:<hash>` retrieves exactly them
 * (the backend filters indexed chunks by `conversationId`).
 */
export function selectionEmailsForIndex(selection: SelectionContext): EmailContext[] {
  return selection.items.filter((i) => i.body.trim().length > 0 || i.subject.trim().length > 0).map((i) => ({ ...i, conversationId: selection.id }));
}

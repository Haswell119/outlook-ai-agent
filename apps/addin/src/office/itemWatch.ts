/**
 * Safety net for "I switched email with the pane open and it still shows the
 * previous one".
 *
 * The supported signal is `ItemChanged` (see `events.ts`), but Outlook does not
 * always deliver it — or delivers it with a stale `Office.context.mailbox.item`
 * (OfficeDev/office-js#5827, #5965). While the pane is visible, `App` calls
 * `pollHostSelection()` about once a second. It asks the host what is selected
 * in the message list (`getSelectedItemsAsync`, Mailbox 1.13) and reacts only
 * when **that selection changed** since the previous poll:
 *
 *   - one message selected, or several from a single conversation (Outlook on
 *     the web selects a whole collapsed conversation) → that message, unless
 *     it is the one on screen or belongs to the conversation on screen;
 *   - several messages from different conversations → left to
 *     `SelectedItemsChanged` and the selection view.
 *
 * When `mailbox.item` already is the selected message, the pane just re-reads
 * it (the event was lost). Otherwise the message is recorded as the selection
 * override (`readItem.ts`) and loaded by id.
 *
 * Reacting to *changes* of the list selection, not to any difference, matters:
 * a message opened from inside an expanded conversation differs from the list
 * selection without the user having moved, and must not be replaced.
 *
 * Not used in a message popped out into its own window: that pane belongs to
 * its message, whatever is selected in the main window's list.
 */
import { isOfficeAvailable } from "./env";
import { hostItemId, isItemLoadSupported, normalizeItemId, sameItemId, setSelectedItemOverride } from "./readItem";
import { getSelectedItemRefs, isMultiSelectSupported, type SelectedItemRef } from "./selection";

export interface SelectionWatch {
  /** Canonical key of the list selection seen at the previous poll (`null` = not observed yet). */
  lastKey: string | null;
}

export const newSelectionWatch = (): SelectionWatch => ({ lastKey: null });

/**
 * True when the pane is docked next to the message list (reading pane, pinned
 * pane). A popped-out message window was opened by Outlook's main window, so
 * its top window has an `opener` — readable across origins.
 */
export function isDockedPane(): boolean {
  try {
    return !(window.top && window.top.opener);
  } catch {
    return true;
  }
}

export function selectionKey(refs: ReadonlyArray<SelectedItemRef>): string {
  return refs
    .map((r) => normalizeItemId(r.itemId))
    .sort()
    .join("|");
}

/** The message a list selection designates, or `null` for a real multi-selection / nothing. */
export function designatedItem(refs: ReadonlyArray<SelectedItemRef>): SelectedItemRef | null {
  if (refs.length === 0) return null;
  if (refs.length === 1) return refs[0]!;
  const conversations = new Set(refs.map((r) => r.conversationId ?? ""));
  if (conversations.size !== 1 || conversations.has("")) return null;
  // A whole conversation: keep the host's item when it is one of them, else the first (newest) one.
  return refs.find((r) => sameItemId(r.itemId, hostItemId())) ?? refs[0]!;
}

/**
 * Compare the host's list selection with what the pane renders.
 * Returns `true` when the pane must re-read the current item.
 */
export async function pollHostSelection(watch: SelectionWatch, rendered: { itemId: string; conversationId: string }): Promise<boolean> {
  if (!isOfficeAvailable() || !isMultiSelectSupported() || !isDockedPane()) return false;
  const refs = await getSelectedItemRefs();
  if (refs === null) return false;
  const key = selectionKey(refs);
  if (watch.lastKey === null || key === watch.lastKey) {
    watch.lastKey = key;
    return false;
  }
  watch.lastKey = key;

  const target = designatedItem(refs);
  if (!target) return false;
  if (sameItemId(target.itemId, rendered.itemId)) return false;
  // Several messages of the conversation already on screen: the reading pane shows that conversation.
  if (refs.length > 1 && rendered.conversationId && target.conversationId === rendered.conversationId) return false;

  if (sameItemId(target.itemId, hostItemId())) {
    // Outlook did swap the item; only the event was lost.
    setSelectedItemOverride(null);
    return true;
  }
  if (!isItemLoadSupported()) return false;
  setSelectedItemOverride(target);
  return true;
}

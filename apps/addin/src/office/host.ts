/**
 * Which surface the pane must render — the single place that answers
 * "where am I and what is selected?".
 *
 * There are five:
 *
 * | surface     | how you get there                                                    | mailbox item |
 * |-------------|----------------------------------------------------------------------|--------------|
 * | `compose`   | compose ribbon button, or `?mode=compose`                            | draft        |
 * | `read`      | an opened message, or one message selected with the pane pinned      | one          |
 * | `selection` | several messages selected in the list (`SupportsMultiSelect`)        | none         |
 * | `brief`     | the "Daily brief" ribbon button (`?view=brief`)                      | any          |
 * | `home`      | the "Apps" rail personal tab (`?host=tab` / `?view=home`), **and**   | none         |
 * |             | the pinned pane with nothing selected (`SupportsNoItemContext`)      |              |
 *
 * `detectSurfaceSync()` is what the first render uses — it must not await
 * anything. `resolveSurface()` then refines the one genuinely ambiguous case:
 * in Outlook, "no item" means *either* nothing selected (`home`: the brief and
 * the chat, no item-bound feature) *or* a multi-selection (`selection`), and
 * only `getSelectedItemsAsync` can tell them apart.
 */
import { hasSelectedItem, isComposeMode, isOfficeAvailable, isPreviewMode, isTabHost, queryParam } from "./env";
import { countSelectedItems, previewSelectionSize } from "./selection";

export type AppSurface = "read" | "compose" | "brief" | "home" | "selection";

/** Synchronous best guess, used for the very first render. */
export function detectSurfaceSync(): AppSurface {
  if (isComposeMode()) return "compose";
  const view = queryParam("view");
  if (view === "home" || isTabHost()) return "home";
  if (view === "brief") return "brief";
  if (previewSelectionSize() > 1 && !isOfficeAvailable()) return "selection";
  // Browser preview always has the sample email, so it renders the read pane.
  if (isPreviewMode()) return "read";
  // Nothing open in Outlook: the brief + chat home, rather than an apologetic
  // "select an email". Refined below when several messages are selected.
  return hasSelectedItem() ? "read" : "home";
}

/**
 * Refine the guess with the one asynchronous question Office.js can answer.
 * Called on mount and again on every `ItemChanged` / `SelectedItemsChanged`.
 */
export async function resolveSurface(sync: AppSurface = detectSurfaceSync()): Promise<AppSurface> {
  // Only "no item in Outlook" is ambiguous; an explicit `?view` wins, and the
  // personal tab has no mailbox to ask.
  if (sync !== "home" || !isOfficeAvailable()) return sync;
  if (queryParam("view") === "home") return sync;
  const count = await countSelectedItems();
  return count > 1 ? "selection" : "home";
}

/**
 * Mailbox-level Office.js events, with **exactly one** Office handler per event
 * type for the whole pane.
 *
 * Why this module exists: a pinned task pane is long-lived. It survives every
 * click in the message list, so an `addHandlerAsync` that is registered per
 * React mount (or per feature) leaks a handler on every re-render and ends up
 * re-running the analysis N times for one item switch.
 *
 * The Office handler is registered **once**, as early as possible
 * (`primeMailboxEvents()` right after `Office.onReady`, as Microsoft
 * documents), and is **never removed**: listeners come and go in JavaScript
 * only. Removing and re-adding it — which React's StrictMode does on every
 * mount in development — races inside Office.js (`removeHandlerAsync` drops
 * *every* handler of the type, asynchronously) and could leave the pane with
 * no handler at all, i.e. stuck on the first email. A failed registration is
 * retried.
 *
 * Events used:
 *   - `ItemChanged` (Mailbox **1.5**) — the user selected another message while
 *     the pane stayed pinned. `Office.context.mailbox.item` is then the new item,
 *     or `null` when nothing (or more than one message) is selected.
 *   - `SelectedItemsChanged` (Mailbox **1.13**) — the multi-select selection
 *     changed while the pane stayed open.
 *
 * Nothing here throws: on a host without the requirement set the subscription
 * is a no-op and the caller simply never gets a callback.
 */
import { asyncResult, isOfficeAvailable, isSetSupported, officeGlobal } from "./env";

export type MailboxEvent = "ItemChanged" | "SelectedItemsChanged";

/** Requirement set that has to be present for the host to raise the event. */
export const EVENT_REQUIREMENT: Record<MailboxEvent, string> = {
  ItemChanged: "1.5",
  SelectedItemsChanged: "1.13",
};

type Listener = () => void;

interface Registration {
  listeners: Set<Listener>;
  handler: () => void;
  /** True once `addHandlerAsync` has been called (or is in flight). */
  added: boolean;
}

const registry = new Map<MailboxEvent, Registration>();

export function isMailboxEventSupported(event: MailboxEvent): boolean {
  return isOfficeAvailable() && isSetSupported("Mailbox", EVENT_REQUIREMENT[event]);
}

function eventType(event: MailboxEvent): unknown {
  try {
    return (officeGlobal() as unknown as { EventType?: Record<string, unknown> } | undefined)?.EventType?.[event];
  } catch {
    return undefined;
  }
}

type Mailbox = {
  addHandlerAsync?: (type: unknown, handler: (args?: unknown) => void, cb: (r: Office.AsyncResult<void>) => void) => void;
};

function mailbox(): Mailbox | undefined {
  try {
    return officeGlobal()?.context?.mailbox as unknown as Mailbox | undefined;
  } catch {
    return undefined;
  }
}

const RETRY_DELAYS_MS = [500, 2000, 5000];

function registration(event: MailboxEvent): Registration {
  let reg = registry.get(event);
  if (!reg) {
    const created: Registration = {
      listeners: new Set<Listener>(),
      added: false,
      handler: () => {
        // Copy first: a listener may unsubscribe itself while we iterate.
        for (const l of [...created.listeners]) {
          try {
            l();
          } catch {
            /* a broken listener must never break the others */
          }
        }
      },
    };
    reg = created;
    registry.set(event, created);
  }
  return reg;
}

/** Register the single Office handler for `event` (idempotent, retried on failure). */
function ensureRegistered(event: MailboxEvent, attempt = 0): void {
  const reg = registration(event);
  if (reg.added || !isMailboxEventSupported(event)) return;
  const type = eventType(event);
  const box = mailbox();
  if (type === undefined || !box?.addHandlerAsync) return;
  // Flip the flag *before* awaiting so a second caller in the same tick
  // cannot register a second Office handler.
  reg.added = true;
  void asyncResult<void>((cb) => box.addHandlerAsync!(type, reg.handler, cb)).catch(() => {
    reg.added = false;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) setTimeout(() => ensureRegistered(event, attempt + 1), delay);
  });
}

/**
 * Register every mailbox event handler now, before any React component
 * mounts. Called from the entry point once Office is ready.
 */
export function primeMailboxEvents(): void {
  ensureRegistered("ItemChanged");
  ensureRegistered("SelectedItemsChanged");
}

/**
 * Subscribe to a mailbox event. Returns an unsubscribe function that is safe to
 * call twice (React 18 StrictMode mounts effects twice in development). It only
 * detaches the JavaScript listener: the Office handler stays registered.
 */
export function addMailboxListener(event: MailboxEvent, listener: Listener): () => void {
  const reg = registration(event);
  reg.listeners.add(listener);
  ensureRegistered(event);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    reg.listeners.delete(listener);
  };
}

/** Whether the Office handler for `event` is registered (diagnostics / tests). */
export function isMailboxEventRegistered(event: MailboxEvent): boolean {
  return registry.get(event)?.added ?? false;
}

/** Number of JS listeners currently attached (diagnostics / tests). */
export function mailboxListenerCount(event: MailboxEvent): number {
  return registry.get(event)?.listeners.size ?? 0;
}

/** Test seam: forget every registration without touching Office.js. */
export function resetMailboxListeners(): void {
  registry.clear();
}

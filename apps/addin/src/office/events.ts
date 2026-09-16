/**
 * Mailbox-level Office.js events, with **exactly one** Office handler per event
 * type for the whole pane.
 *
 * Why this module exists: a pinned task pane is long-lived. It survives every
 * click in the message list, so an `addHandlerAsync` that is registered per
 * React mount (or per feature) leaks a handler on every re-render and ends up
 * re-running the analysis N times for one item switch. Here the Office handler
 * is added when the **first** listener subscribes and removed when the **last**
 * one unsubscribes; everything in between is pure JavaScript fan-out.
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
  removeHandlerAsync?: (type: unknown, cb: (r: Office.AsyncResult<void>) => void) => void;
};

function mailbox(): Mailbox | undefined {
  try {
    return officeGlobal()?.context?.mailbox as unknown as Mailbox | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to a mailbox event. Returns an unsubscribe function that is safe to
 * call twice (React 18 StrictMode mounts effects twice in development).
 */
export function addMailboxListener(event: MailboxEvent, listener: Listener): () => void {
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
  const registration = reg;
  registration.listeners.add(listener);

  if (!registration.added && isMailboxEventSupported(event)) {
    // Flip the flag *before* awaiting so a second subscriber in the same tick
    // cannot register a second Office handler.
    registration.added = true;
    const type = eventType(event);
    const box = mailbox();
    if (type === undefined || !box?.addHandlerAsync) {
      registration.added = false;
    } else {
      void asyncResult<void>((cb) => box.addHandlerAsync!(type, registration.handler, cb)).catch(() => {
        registration.added = false;
      });
    }
  }

  let done = false;
  return () => {
    if (done) return;
    done = true;
    registration.listeners.delete(listener);
    if (registration.listeners.size > 0 || !registration.added) return;
    registration.added = false;
    const type = eventType(event);
    const box = mailbox();
    if (type === undefined || !box?.removeHandlerAsync) return;
    void asyncResult<void>((cb) => box.removeHandlerAsync!(type, cb)).catch(() => undefined);
  };
}

/** Number of JS listeners currently attached (diagnostics / tests). */
export function mailboxListenerCount(event: MailboxEvent): number {
  return registry.get(event)?.listeners.size ?? 0;
}

/** Test seam: forget every registration without touching Office.js. */
export function resetMailboxListeners(): void {
  registry.clear();
}

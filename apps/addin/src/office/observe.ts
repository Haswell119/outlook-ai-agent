/**
 * Fire-and-forget observation of user actions (Automation Coach routine
 * detection). Never throws, never blocks the UI, never delays a render.
 *
 * When the backend is unreachable the event goes to the bounded outbox
 * (`net/outbox`) and is flushed on the next successful connectivity change or
 * on the next successful observation. Events older than 24 h are dropped.
 */
import { emailDomain, type EmailContext, type UserActionEvent } from "@oao/shared";
import { getApi } from "@/api";
import { browserOnline, onConnectivityChange } from "@/net/connectivity";
import { enqueue, flush, size as outboxSize } from "@/net/outbox";
import { track } from "@/telemetry";

export function eventFromEmail(type: UserActionEvent["type"], email: EmailContext, parameters: Record<string, unknown> = {}): UserActionEvent {
  const from = email.from?.address;
  return {
    type,
    occurredAt: new Date().toISOString(),
    email: {
      id: email.id,
      conversationId: email.conversationId,
      fromAddress: from,
      fromDomain: from ? emailDomain(from) : undefined,
      subject: email.subject,
      hasAttachments: email.attachments.length > 0,
      attachmentTypes: email.attachments.map((a) => a.name.split(".").pop()?.toLowerCase() ?? "").filter(Boolean),
    },
    parameters,
  };
}

const seen = new Set<string>();
let flushing = false;

/** Send everything that is queued. Safe to call at any time. */
export async function flushObservations(): Promise<void> {
  if (flushing || !browserOnline() || outboxSize() === 0) return;
  flushing = true;
  try {
    const result = await flush((event) => getApi().observe(event));
    if (result.sent || result.dropped) track("outbox.flush", { sent: result.sent, dropped: result.dropped, remaining: result.remaining });
  } finally {
    flushing = false;
  }
}

export function observeUserAction(event: UserActionEvent): void {
  // De-duplicate open_email within a session (one event per opened item).
  if (event.type === "open_email") {
    const key = `open:${event.email.id}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  if (!browserOnline()) {
    enqueue(event);
    return;
  }
  void getApi()
    .observe(event)
    .then(() => void flushObservations())
    .catch(() => enqueue(event));
}

let wired = false;

/** Called once from the app shell: retry the outbox when we come back online. */
export function startObservationFlusher(): () => void {
  if (wired) return () => undefined;
  wired = true;
  const off = onConnectivityChange((state) => {
    if (state === "online") void flushObservations();
  });
  void flushObservations();
  return () => {
    wired = false;
    off();
  };
}

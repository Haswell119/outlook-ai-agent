/**
 * Fire-and-forget observation of user actions (Automation Coach routine detection).
 * Never throws, never blocks the UI.
 */
import { emailDomain, type EmailContext, type UserActionEvent } from "@oao/shared";
import { getApi } from "@/api";

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

export function observeUserAction(event: UserActionEvent): void {
  // De-duplicate open_email within a session (one event per opened item).
  if (event.type === "open_email") {
    const key = `open:${event.email.id}`;
    if (seen.has(key)) return;
    seen.add(key);
  }
  void getApi()
    .observe(event)
    .catch(() => undefined);
}

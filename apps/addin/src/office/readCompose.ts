import type { AttachmentMeta, ComposeContext, EmailAddress } from "@oao/shared";
import { isOfficeAvailable, isSetSupported, officeGlobal, tryAsync } from "./env";
import { sampleCompose } from "./sample";

function toAddresses(list: Office.EmailAddressDetails[] | undefined): EmailAddress[] {
  return (list ?? [])
    .filter((d) => !!d?.emailAddress)
    .map((d) => ({ name: d.displayName || undefined, address: d.emailAddress }));
}

/** Read the draft being composed (recipients, subject, body, attachments, from). */
export async function readCompose(): Promise<ComposeContext> {
  if (!isOfficeAvailable()) return sampleCompose;
  const item = officeGlobal()!.context.mailbox.item as unknown as Office.MessageCompose;

  const [to, cc, bcc, subject, body] = await Promise.all([
    tryAsync<Office.EmailAddressDetails[]>((cb) => item.to.getAsync(cb), []),
    tryAsync<Office.EmailAddressDetails[]>((cb) => item.cc.getAsync(cb), []),
    tryAsync<Office.EmailAddressDetails[]>((cb) => item.bcc.getAsync(cb), []),
    tryAsync<string>((cb) => item.subject.getAsync(cb), ""),
    tryAsync<string>((cb) => item.body.getAsync(Office.CoercionType.Text, cb), ""),
  ]);

  let attachments: AttachmentMeta[] = [];
  if (isSetSupported("Mailbox", "1.8") && typeof item.getAttachmentsAsync === "function") {
    const list = await tryAsync<Office.AttachmentDetailsCompose[]>((cb) => item.getAttachmentsAsync(cb), []);
    attachments = (list ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      size: typeof a.size === "number" ? a.size : undefined,
      isInline: a.isInline,
    }));
  }

  let from: EmailAddress | undefined;
  if (isSetSupported("Mailbox", "1.7") && item.from && typeof item.from.getAsync === "function") {
    const f = await tryAsync<Office.EmailAddressDetails | undefined>((cb) => item.from.getAsync(cb), undefined);
    if (f?.emailAddress) from = { name: f.displayName || undefined, address: f.emailAddress };
  }
  if (!from) {
    const profile = officeGlobal()?.context.mailbox.userProfile;
    if (profile?.emailAddress) from = { name: profile.displayName, address: profile.emailAddress };
  }

  let draftId: string | undefined;
  try {
    draftId = (item as unknown as { itemId?: string }).itemId || undefined;
  } catch {
    draftId = undefined;
  }

  return { draftId, from, to: toAddresses(to), cc: toAddresses(cc), bcc: toAddresses(bcc), subject: subject ?? "", body: body ?? "", attachments };
}

/**
 * Subscribe to recipients / attachments changes in compose mode (Mailbox 1.7 / 1.8).
 * Returns an unsubscribe function. No-op in preview mode.
 */
export function onComposeChanged(handler: () => void): () => void {
  if (!isOfficeAvailable() || !isSetSupported("Mailbox", "1.7")) return () => undefined;
  const item = officeGlobal()!.context.mailbox.item as unknown as Office.MessageCompose;
  const events: Office.EventType[] = [Office.EventType.RecipientsChanged];
  if (isSetSupported("Mailbox", "1.8")) events.push(Office.EventType.AttachmentsChanged);
  for (const ev of events) {
    try {
      item.addHandlerAsync(ev, handler, () => undefined);
    } catch {
      /* ignore */
    }
  }
  return () => {
    for (const ev of events) {
      try {
        item.removeHandlerAsync(ev, () => undefined);
      } catch {
        /* ignore */
      }
    }
  };
}

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

  const sensitivityLabel = await readSensitivityLabel(item);

  let draftId: string | undefined;
  try {
    draftId = (item as unknown as { itemId?: string }).itemId || undefined;
  } catch {
    draftId = undefined;
  }

  return { draftId, from, to: toAddresses(to), cc: toAddresses(cc), bcc: toAddresses(bcc), subject: subject ?? "", body: body ?? "", attachments, sensitivityLabel };
}

/**
 * The draft's sensitivity (classification) label, as a **display name**.
 *
 * Without this the Compliance Guardian reported "Missing classification label"
 * on every draft, including the ones the user had just labelled — and its own
 * "Apply Confidential label" action appeared to do nothing, because the
 * re-check still sent `sensitivityLabel: undefined`. The policy compares
 * display names ("Internal", "Confidential"), while the item exposes the
 * catalogue **id**, so the id is resolved through the labels catalogue when the
 * host offers it (Mailbox 1.13 + IRM) and passed through otherwise.
 */
async function readSensitivityLabel(item: Office.MessageCompose): Promise<string | undefined> {
  if (!isSetSupported("Mailbox", "1.13")) return undefined;
  const accessor = (item as unknown as { sensitivityLabel?: { getAsync?: (cb: (r: Office.AsyncResult<unknown>) => void) => void } }).sensitivityLabel;
  if (typeof accessor?.getAsync !== "function") return undefined;
  const raw = await tryAsync<unknown>((cb) => accessor.getAsync!(cb), undefined);
  const id = typeof raw === "string" ? raw : typeof (raw as { id?: unknown })?.id === "string" ? (raw as { id: string }).id : undefined;
  if (!id) return undefined;
  const catalog = (officeGlobal()?.context as unknown as { sensitivityLabelsCatalog?: { getAsync?: (cb: (r: Office.AsyncResult<Array<{ id?: string; name?: string }>>) => void) => void } } | undefined)?.sensitivityLabelsCatalog;
  if (typeof catalog?.getAsync === "function") {
    const labels = await tryAsync<Array<{ id?: string; name?: string }>>((cb) => catalog.getAsync!(cb), []);
    const match = (labels ?? []).find((l) => l?.id === id);
    if (match?.name) return match.name;
  }
  return id;
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

import type { AttachmentMeta, EmailAddress, EmailContext } from "@oao/shared";
import { asyncResult, isOfficeAvailable, isSetSupported, officeGlobal, tryAsync } from "./env";
import { sampleEmail } from "./sample";
import { cacheItem } from "./cache";

function toAddress(d: Office.EmailAddressDetails | undefined): EmailAddress | undefined {
  if (!d?.emailAddress) return undefined;
  return { name: d.displayName || undefined, address: d.emailAddress };
}

function toAddresses(list: Office.EmailAddressDetails[] | undefined): EmailAddress[] {
  return (list ?? []).map(toAddress).filter((a): a is EmailAddress => !!a);
}

function toAttachment(a: Office.AttachmentDetails): AttachmentMeta {
  return {
    id: a.id,
    name: a.name,
    size: typeof a.size === "number" ? a.size : undefined,
    contentType: a.contentType || undefined,
    isInline: a.isInline,
  };
}

/**
 * Read the currently opened message (read mode) into the shared EmailContext.
 * Every optional Office.js API is guarded by a requirement-set check.
 * In preview mode (no Outlook) the ABC Capital sample email is returned.
 */
export async function readCurrentItem(): Promise<EmailContext> {
  if (!isOfficeAvailable()) {
    cacheItem(sampleEmail);
    return sampleEmail;
  }
  const item = officeGlobal()!.context.mailbox.item as unknown as Office.MessageRead;

  const body = await tryAsync<string>((cb) => item.body.getAsync(Office.CoercionType.Text, cb), "");

  let categories: string[] = [];
  if (isSetSupported("Mailbox", "1.8") && item.categories) {
    const cats = await tryAsync<Office.CategoryDetails[]>((cb) => item.categories.getAsync(cb), []);
    categories = (cats ?? []).map((c) => c.displayName);
  }

  let internetMessageId: string | undefined;
  try {
    internetMessageId = item.internetMessageId || undefined;
  } catch {
    internetMessageId = undefined;
  }

  let importance: EmailContext["importance"];
  try {
    // Not part of the typed MessageRead surface on every host; guarded access.
    const raw = (item as unknown as { importance?: string }).importance;
    if (raw === "low" || raw === "normal" || raw === "high") importance = raw;
  } catch {
    importance = undefined;
  }

  const email: EmailContext = {
    id: item.itemId,
    conversationId: item.conversationId || undefined,
    internetMessageId,
    subject: item.subject ?? "",
    from: toAddress(item.from),
    to: toAddresses(item.to),
    cc: toAddresses(item.cc),
    bcc: [],
    receivedAt: item.dateTimeCreated ? new Date(item.dateTimeCreated).toISOString() : undefined,
    body,
    attachments: (item.attachments ?? []).map(toAttachment),
    categories,
    importance,
    // Office.js has no webLink; the backend fills it in via Graph when enabled.
    webLink: undefined,
  };
  cacheItem(email);
  return email;
}

/** Read an EWS-style item id converted to a REST id (used for deep links when the host supports it). */
export function toRestId(itemId: string): string {
  try {
    if (isSetSupported("Mailbox", "1.3")) {
      return officeGlobal()!.context.mailbox.convertToRestId(itemId, Office.MailboxEnums.RestVersion.v2_0);
    }
  } catch {
    /* ignore */
  }
  return itemId;
}

/** Best-effort deep link to a message; returns undefined when unsupported. */
export function messageWebLink(itemId: string): string | undefined {
  try {
    const mailbox = officeGlobal()?.context.mailbox;
    if (!mailbox || !isSetSupported("Mailbox", "1.5")) return undefined;
    const ewsUrl = mailbox.ewsUrl;
    if (!ewsUrl) return undefined;
    const origin = new URL(ewsUrl).origin;
    return `${origin}/owa/?ItemID=${encodeURIComponent(toRestId(itemId))}&exvsurl=1&viewmodel=ReadMessageItem`;
  } catch {
    return undefined;
  }
}

/** Asserts we have a read item (throws a friendly error otherwise). */
export function requireReadItem(): Office.MessageRead {
  if (!isOfficeAvailable()) throw new Error("Office.js unavailable");
  return officeGlobal()!.context.mailbox.item as unknown as Office.MessageRead;
}

export { asyncResult };

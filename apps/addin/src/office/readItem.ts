import type { AttachmentMeta, EmailAddress, EmailContext } from "@oao/shared";
import { asyncResult, isOfficeAvailable, isSetSupported, officeGlobal, queryParam, tryAsync } from "./env";
import { sampleEmail, sampleNewsletter } from "./sample";
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
 * Identity of the message the **host** currently has selected, read
 * synchronously and with no side effects.
 *
 * This is the pane's single answer to "which email am I supposed to be showing
 * right now?", and everything item-bound is keyed by it. It matters because
 * `Office.context.mailbox.item` is swapped in place by Outlook: an id read once
 * at mount, or a value cached in a module, goes stale the moment the user clicks
 * another message — which is how a pane ends up displaying the previous email.
 *
 * Returns `""` when nothing is open (message closed, multi-selection, the
 * Apps-rail personal tab), which is exactly the "no item" surface.
 */
export function currentItemId(): string {
  if (!isOfficeAvailable()) {
    // Browser preview has a fixed sample item, so its id is stable too.
    return previewItem().id;
  }
  const o = activeOverride();
  return o ? o.id : hostItemId();
}

/** Conversation of the message the pane is about (override-aware), `""` when unknown. */
export function currentConversationId(): string {
  if (!isOfficeAvailable()) return previewItem().conversationId ?? "";
  const o = activeOverride();
  if (o) return o.conversationId;
  try {
    const item = officeGlobal()?.context?.mailbox?.item as unknown as { conversationId?: unknown } | null | undefined;
    return typeof item?.conversationId === "string" ? item.conversationId : "";
  } catch {
    return "";
  }
}

/** `Office.context.mailbox.item.itemId`, exactly as the host reports it (`""` = no item). */
export function hostItemId(): string {
  try {
    const item = officeGlobal()?.context?.mailbox?.item as unknown as { itemId?: unknown } | null | undefined;
    const id = item?.itemId;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/**
 * EWS ids come back base64 or base64url depending on the API and the host;
 * compare them in one canonical form.
 */
export function normalizeItemId(id: string | undefined | null): string {
  return (id ?? "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
}

export function sameItemId(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeItemId(a);
  return na !== "" && na === normalizeItemId(b);
}

/* ---------------------------------------------------------------------------
 * Selection override.
 *
 * Outlook is supposed to swap `Office.context.mailbox.item` and raise
 * `ItemChanged` when the user selects another message while the pane stays
 * open. Known host bugs break both halves (the event is not raised for some
 * messages; or it is, but `mailbox.item` still points at the first message —
 * OfficeDev/office-js#5827, #5965). When the pane learns from
 * `getSelectedItemsAsync` that the list selection moved to a message the host
 * item did not follow, it records that message here: `currentItemId()` /
 * `currentItemSubject()` report it and `readCurrentItem()` loads it by id
 * (`loadItemByIdAsync`). The override clears itself as soon as the host item
 * changes, i.e. when Outlook catches up.
 * ------------------------------------------------------------------------- */

interface SelectionOverride {
  id: string;
  subject: string;
  conversationId: string;
  /** Host item id when the override was set; any change means Outlook caught up. */
  baseId: string;
}

let override: SelectionOverride | null = null;

export function setSelectedItemOverride(ref: { itemId: string; subject?: string; conversationId?: string } | null): void {
  override = ref ? { id: ref.itemId, subject: ref.subject ?? "", conversationId: ref.conversationId ?? "", baseId: hostItemId() } : null;
}

function activeOverride(): SelectionOverride | null {
  if (!override) return null;
  const host = hostItemId();
  if (normalizeItemId(host) !== normalizeItemId(override.baseId) || sameItemId(host, override.id)) {
    override = null;
  }
  return override;
}

/** True when the pane shows a message the host item has not followed (diagnostics / tests). */
export function hasSelectedItemOverride(): boolean {
  return activeOverride() !== null;
}

/** True when whole messages can be loaded from their id (Mailbox 1.15). */
export function isItemLoadSupported(): boolean {
  try {
    const mailbox = officeGlobal()?.context?.mailbox as unknown as { loadItemByIdAsync?: unknown } | undefined;
    return isOfficeAvailable() && isSetSupported("Mailbox", "1.15") && typeof mailbox?.loadItemByIdAsync === "function";
  } catch {
    return false;
  }
}

/** One `loadItemByIdAsync` at a time: Outlook requires `unloadAsync` before the next load. */
let loadChain: Promise<unknown> = Promise.resolve();

/**
 * Load a message by its EWS id and map it, then unload it. Serialised across
 * the whole pane (the selection view loads its messages through here too).
 * Returns `null` when the host cannot load it.
 */
export function loadMessageById(itemId: string): Promise<EmailContext | null> {
  const run = async (): Promise<EmailContext | null> => {
    if (!isItemLoadSupported()) return null;
    const mailbox = officeGlobal()!.context.mailbox as unknown as {
      loadItemByIdAsync: (id: string, cb: (r: Office.AsyncResult<Office.MessageRead>) => void) => void;
    };
    let loaded: (Office.MessageRead & { unloadAsync?: (cb: (r: Office.AsyncResult<void>) => void) => void }) | undefined;
    try {
      loaded = (await asyncResult<Office.MessageRead>((cb) => mailbox.loadItemByIdAsync(itemId, cb))) as typeof loaded;
      if (!loaded) return null;
      const email = await readMessageItem(loaded, itemId);
      return email.id ? email : { ...email, id: itemId };
    } catch {
      return null;
    } finally {
      if (loaded && typeof loaded.unloadAsync === "function") {
        const item = loaded;
        await asyncResult<void>((cb) => item.unloadAsync!(cb)).catch(() => undefined);
      }
    }
  };
  const p = loadChain.then(run, run);
  loadChain = p.catch(() => undefined);
  return p;
}

/**
 * Subject of the message the host currently has selected, read synchronously.
 *
 * Outlook exposes `item.subject` as a plain string on a read item (only compose
 * items make it an accessor), so the pane can name the email it is working on
 * *before* the slow `body.getAsync` comes back — which is what makes a loading
 * state honest instead of anonymous.
 */
export function currentItemSubject(): string {
  if (!isOfficeAvailable()) return previewItem().subject;
  const o = activeOverride();
  if (o) return o.subject;
  try {
    const item = officeGlobal()?.context?.mailbox?.item as unknown as { subject?: unknown } | null | undefined;
    return typeof item?.subject === "string" ? item.subject : "";
  } catch {
    return "";
  }
}

/** The sample item shown in browser preview (`?sample=newsletter` for triage). */
function previewItem(): EmailContext {
  return queryParam("sample") === "newsletter" ? sampleNewsletter : sampleEmail;
}

/**
 * Read the currently opened message (read mode) into the shared EmailContext.
 * Every optional Office.js API is guarded by a requirement-set check.
 * In preview mode (no Outlook) the sample email is returned.
 *
 * Nothing is memoised on purpose: the caller re-reads on every `ItemChanged`
 * and the returned context is always the item the host holds *now*.
 */
export async function readCurrentItem(): Promise<EmailContext> {
  if (!isOfficeAvailable()) {
    const sample = previewItem();
    cacheItem(sample);
    return sample;
  }
  const o = activeOverride();
  if (o) {
    // The list selection moved but `mailbox.item` did not follow: read the
    // selected message by id. If that fails, the host item is still the wrong
    // message, so it must not be shown in its place.
    const loaded = await loadMessageById(o.id);
    if (loaded) return loaded;
    throw new NoItemError();
  }
  const item = officeGlobal()!.context.mailbox.item as unknown as Office.MessageRead | null;
  // The message was closed (or the selection became a multi-selection) while we
  // were being called: say so instead of throwing a TypeError on `item.body`.
  if (!item) throw new NoItemError();
  return readMessageItem(item);
}

/** Thrown by `readCurrentItem()` when the host has no message open any more. */
export class NoItemError extends Error {
  constructor() {
    super("No message is open in Outlook");
    this.name = "NoItemError";
  }
}

/**
 * Map an Office.js read item to the shared `EmailContext`.
 *
 * Used for the item currently open in the reading pane **and** for the items
 * returned by `loadItemByIdAsync` in the multi-select selection view, which
 * expose the same read-item surface (`fallbackId` is used when a loaded item
 * does not carry its own `itemId`).
 */
export async function readMessageItem(item: Office.MessageRead, fallbackId?: string): Promise<EmailContext> {
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
    id: item.itemId || fallbackId || "",
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

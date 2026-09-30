/**
 * Mail files → `EmailContext`: the import path used when Microsoft Graph is not
 * connected. An `.eml` (RFC 5322 / MIME) or an Outlook `.msg` (compound file)
 * is mapped to the exact shape `graphMessageToEmail` gives a Graph message, so
 * imported mail then goes through the same pipeline as a mailbox sync.
 *
 * Pure: no I/O, no logging. The content is untrusted — it is parsed, never
 * executed, and nothing it contains changes how it is parsed.
 *
 * Identity, so that importing the same messages again changes nothing:
 *  - `id` derives from the Internet Message-ID (the same message exported as
 *    `.eml` and as `.msg` gets the same id), else from the file content;
 *  - `conversationId` derives from the thread root: first `References` id, else
 *    `In-Reply-To`, else the message's own id; without any of them, from the
 *    subject stripped of its reply / forward prefixes.
 */
import { createHash } from "node:crypto";
import MsgReaderModule from "@kenjiuno/msgreader";
import { EmailContextSchema, type EmailAddress, type EmailContext } from "@oao/shared";
import PostalMime from "postal-mime";
import { htmlToText, normalizeWhitespace, truncate } from "../../util/text.js";

export type MailFileFormat = "eml" | "msg";

/** Largest file accepted: a message with its attachments. */
export const MAX_MAIL_FILE_BYTES = 25 * 1024 * 1024;
/** Body text kept per message (the prompts cap what reaches the model anyway). */
export const MAX_IMPORTED_BODY_CHARS = 100_000;
/** Subject kept per message. */
export const MAX_SUBJECT_CHARS = 998;

/** A file that cannot be imported; reported per file, never fatal for a batch. */
export class MailFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailFileError";
  }
}

export interface MailFile {
  /** File name as uploaded (extension used as a hint only). */
  name: string;
  bytes: Uint8Array;
  /** Folder the file came from (relative path of a folder upload), e.g. `Inbox/Clients`. */
  folder?: string;
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** `msg` for an OLE compound file, `eml` for an RFC 5322 message, `undefined` otherwise. */
export function detectMailFormat(name: string, bytes: Uint8Array): MailFileFormat | undefined {
  if (bytes.length >= CFB_MAGIC.length && CFB_MAGIC.every((b, i) => bytes[i] === b)) return "msg";
  if (name.toLowerCase().endsWith(".msg")) return undefined; // a .msg that is not a compound file
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  // An RFC 5322 message starts with header fields ("Received:", "From:", "Message-ID:"…).
  return /^(?:[\t ]*\r?\n)*[A-Za-z][A-Za-z0-9-]*:[ \t]/.test(head) ? "eml" : undefined;
}

export async function parseMailFile(file: MailFile): Promise<EmailContext> {
  if (file.bytes.length === 0) throw new MailFileError("empty file");
  if (file.bytes.length > MAX_MAIL_FILE_BYTES) throw new MailFileError(`larger than ${MAX_MAIL_FILE_BYTES / 1024 / 1024} MB`);
  const format = detectMailFormat(file.name, file.bytes);
  if (!format) throw new MailFileError("not an .eml or .msg message");
  const parsed = format === "msg" ? fromMsg(file.bytes) : await fromEml(file.bytes);
  return toEmailContext(parsed, file);
}

/* ------------------------------------------------------------------------- */

interface ParsedMail {
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  from?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  sentAt?: string;
  receivedAt?: string;
  text: string;
  importance?: EmailContext["importance"];
  attachments: EmailContext["attachments"];
}

interface PostalAddress {
  name?: string;
  address?: string;
  group?: PostalAddress[];
}

const isAddress = (a: string | undefined): a is string => !!a && /^[^\s@<>]+@[^\s@<>]+$/.test(a.trim());

function flatten(list: PostalAddress[] | PostalAddress | undefined): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of Array.isArray(list) ? list : list ? [list] : []) {
    if (a.group) out.push(...flatten(a.group));
    else if (isAddress(a.address)) out.push({ address: a.address.trim().toLowerCase(), ...(a.name?.trim() ? { name: a.name.trim() } : {}) });
  }
  return out;
}

/** Every `<id>` of a Message-ID / In-Reply-To / References value, in order. */
export function messageIds(value: string | undefined): string[] {
  return value ? [...value.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]) : [];
}

function isoDate(value: string | Date | undefined): string | undefined {
  if (!value) return undefined;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Importance from `Importance` / `X-Priority` / `Priority` header values. */
export function importanceOf(importance?: string, xPriority?: string): EmailContext["importance"] {
  const v = (importance ?? "").trim().toLowerCase();
  if (v === "high" || v === "urgent") return "high";
  if (v === "low" || v === "non-urgent") return "low";
  const p = Number.parseInt((xPriority ?? "").trim(), 10);
  if (p === 1 || p === 2) return "high";
  if (p === 4 || p === 5) return "low";
  return v === "normal" || p === 3 ? "normal" : undefined;
}

async function fromEml(bytes: Uint8Array): Promise<ParsedMail> {
  let email: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    email = await PostalMime.parse(bytes);
  } catch (e) {
    throw new MailFileError(`not a readable email (${(e as Error).message.slice(0, 120)})`);
  }
  const header = (name: string) => email.headers.find((h) => h.key === name)?.value;
  const date = isoDate(email.date);
  return {
    messageId: messageIds(email.messageId)[0],
    inReplyTo: messageIds(email.inReplyTo)[0],
    references: messageIds(email.references),
    subject: email.subject ?? "",
    from: flatten(email.from as PostalAddress | undefined)[0],
    to: flatten(email.to as PostalAddress[] | undefined),
    cc: flatten(email.cc as PostalAddress[] | undefined),
    bcc: flatten(email.bcc as PostalAddress[] | undefined),
    sentAt: date,
    receivedAt: date,
    text: email.text?.trim() ? email.text : htmlToText(email.html ?? ""),
    importance: importanceOf(header("importance") ?? header("priority"), header("x-priority")),
    attachments: email.attachments.map((a) => ({
      name: a.filename || "attachment",
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
      contentType: a.mimeType || undefined,
      isInline: a.disposition === "inline" || (!!a.contentId && a.disposition !== "attachment"),
    })),
  };
}

type MsgReaderClass = new (data: ArrayBuffer | DataView | Uint8Array) => { getFileData(): MsgData };
interface MsgData {
  dataType?: string | null;
  error?: string;
  subject?: string;
  body?: string;
  /** PR_HTML as a Unicode string (rare)… */
  bodyHtml?: string;
  /** …or, usually, as bytes in the message's code page. */
  html?: Uint8Array;
  internetCodepage?: number;
  senderName?: string;
  senderEmail?: string;
  senderSmtpAddress?: string;
  headers?: string;
  messageDeliveryTime?: string;
  clientSubmitTime?: string;
  recipients?: Array<{ name?: string; email?: string; smtpAddress?: string; recipType?: "to" | "cc" | "bcc" }>;
  attachments?: Array<{ fileName?: string; fileNameShort?: string; contentLength?: number; attachMimeTag?: string; pidContentId?: string; attachmentHidden?: boolean }>;
}
const MsgReader = ((MsgReaderModule as unknown as { default?: MsgReaderClass }).default ?? MsgReaderModule) as unknown as MsgReaderClass;

/** Windows code pages Outlook stores PR_HTML in → WHATWG encoding labels. */
const CODE_PAGES: Record<number, string> = { 65001: "utf-8", 1200: "utf-16le", 1250: "windows-1250", 1251: "windows-1251", 1252: "windows-1252", 1253: "windows-1253", 1254: "windows-1254", 20127: "us-ascii", 28591: "iso-8859-1", 28592: "iso-8859-2", 28605: "iso-8859-15", 50220: "iso-2022-jp", 932: "shift_jis", 936: "gbk", 949: "euc-kr", 950: "big5" };

function decodeHtml(bytes: Uint8Array | undefined, codePage: number | undefined): string {
  if (!bytes?.length) return "";
  try {
    return new TextDecoder(CODE_PAGES[codePage ?? 65001] ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Header field values of a raw header block (unfolded, case-insensitive, first occurrence). */
export function headerFields(block: string | undefined): Map<string, string> {
  const fields = new Map<string, string>();
  const unfolded = (block ?? "").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
    if (m && !fields.has(m[1]!.toLowerCase())) fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  return fields;
}

function fromMsg(bytes: Uint8Array): ParsedMail {
  let data: MsgData;
  try {
    // msgreader reads to the end of the backing ArrayBuffer: hand it an exact-size
    // copy when `bytes` is a view (a small Node Buffer is a slice of a shared pool).
    const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
    data = new MsgReader(own).getFileData();
  } catch (e) {
    throw new MailFileError(`not a readable Outlook message (${(e as Error).message.slice(0, 120)})`);
  }
  if (data.error || data.dataType !== "msg") throw new MailFileError("not a readable Outlook message");
  const h = headerFields(data.headers);
  const sender = [data.senderSmtpAddress, data.senderEmail].find(isAddress);
  // Exchange (X.500) senders carry no SMTP address in the properties: the transport headers do.
  const from = sender ? { address: sender.toLowerCase(), ...(data.senderName ? { name: data.senderName } : {}) } : flatten(parseAddressList(h.get("from")))[0];
  const recipients = (kind: "to" | "cc" | "bcc") =>
    (data.recipients ?? [])
      .filter((r) => (r.recipType ?? "to") === kind)
      .flatMap((r) => {
        const address = [r.smtpAddress, r.email].find(isAddress);
        return address ? [{ address: address.toLowerCase(), ...(r.name && r.name !== address ? { name: r.name } : {}) }] : [];
      });
  return {
    messageId: messageIds(h.get("message-id"))[0],
    inReplyTo: messageIds(h.get("in-reply-to"))[0],
    references: messageIds(h.get("references")),
    subject: data.subject ?? "",
    from,
    to: recipients("to"),
    cc: recipients("cc"),
    bcc: recipients("bcc"),
    sentAt: isoDate(data.clientSubmitTime) ?? isoDate(h.get("date")),
    receivedAt: isoDate(data.messageDeliveryTime) ?? isoDate(h.get("date")),
    text: data.body?.trim() ? data.body : htmlToText(data.bodyHtml ?? decodeHtml(data.html, data.internetCodepage)),
    importance: importanceOf(h.get("importance") ?? h.get("priority"), h.get("x-priority")),
    attachments: (data.attachments ?? []).map((a) => ({
      name: a.fileName || a.fileNameShort || "attachment",
      size: typeof a.contentLength === "number" ? a.contentLength : undefined,
      contentType: a.attachMimeTag || undefined,
      isInline: !!a.attachmentHidden || !!a.pidContentId,
    })),
  };
}

/** `Name <a@b>, c@d` → address objects (the From header of a .msg transport block). */
function parseAddressList(value: string | undefined): PostalAddress[] {
  if (!value) return [];
  // The quote-aware split rescans the rest of the value at every comma: keep it short.
  return value.slice(0, 4096).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => {
    const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(part);
    return m ? { name: m[1]!.trim(), address: m[2]!.trim() } : { address: part.trim() };
  });
}

/** Subject without reply / forward prefixes (`Re:`, `TR :`, `Fwd:`, `AW:`, `RE[2]:`…). */
export function threadSubject(subject: string): string {
  let s = normalizeWhitespace(subject);
  for (;;) {
    const next = s.replace(/^(?:re|fw|fwd|tr|réf|ref|aw|wg|sv|vs|rv)\s*(?:\[\d+\])?\s*:\s*/i, "");
    if (next === s) return s.toLowerCase();
    s = next;
  }
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex").slice(0, 32);

function toEmailContext(m: ParsedMail, file: MailFile): EmailContext {
  const root = m.references[0] ?? m.inReplyTo ?? m.messageId;
  const body = truncate(m.text.replace(/\r\n?/g, "\n").trim(), MAX_IMPORTED_BODY_CHARS);
  // RFC 5322 caps a line at 998 characters; anything longer is not a real subject.
  const subject = m.subject.slice(0, MAX_SUBJECT_CHARS);
  return EmailContextSchema.parse({
    id: `imp-${digest(m.messageId ?? file.bytes)}`,
    conversationId: `impc-${digest(root ?? `subject:${threadSubject(subject)}`)}`,
    ...(m.messageId ? { internetMessageId: m.messageId } : {}),
    subject,
    ...(m.from ? { from: m.from } : {}),
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    ...(m.receivedAt ? { receivedAt: m.receivedAt } : {}),
    ...(m.sentAt ? { sentAt: m.sentAt } : {}),
    body,
    bodyPreview: truncate(normalizeWhitespace(body), 255),
    attachments: m.attachments,
    ...(m.importance ? { importance: m.importance } : {}),
    ...(file.folder?.trim() ? { folder: file.folder.trim() } : {}),
  });
}

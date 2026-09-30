/**
 * Synthetic mail files for the import tests: RFC 5322 `.eml` text and Outlook
 * `.msg` compound files written with msgreader's own CFB burner, so no
 * third-party or real mailbox file is committed.
 */
import { burn } from "@kenjiuno/msgreader/lib/Burner.js";

const CRLF = "\r\n";

export interface EmlSpec {
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  html?: string;
  importance?: string;
  attachment?: { name: string; base64: string };
}

export function eml(spec: EmlSpec): Uint8Array {
  const head = [
    spec.messageId && `Message-ID: ${spec.messageId}`,
    spec.inReplyTo && `In-Reply-To: ${spec.inReplyTo}`,
    spec.references?.length && `References: ${spec.references.join(" ")}`,
    `Date: ${spec.date ?? "Mon, 29 Sep 2026 10:05:00 +0200"}`,
    `From: ${spec.from ?? '"Jean Dupont" <jean@client.example>'}`,
    `To: ${spec.to ?? "defi-ia@outlook.com"}`,
    spec.cc && `Cc: ${spec.cc}`,
    `Subject: ${spec.subject ?? "Facture"}`,
    spec.importance && `Importance: ${spec.importance}`,
    "MIME-Version: 1.0",
  ].filter(Boolean) as string[];
  const text = spec.text ?? "Bonjour";
  let body: string[];
  if (!spec.attachment && !spec.html) {
    body = ["Content-Type: text/plain; charset=utf-8", "", text];
  } else {
    const parts: string[] = [];
    if (spec.text !== undefined || !spec.html) parts.push("--B1", "Content-Type: text/plain; charset=utf-8", "", text);
    if (spec.html) parts.push("--B1", "Content-Type: text/html; charset=utf-8", "", spec.html);
    if (spec.attachment) parts.push("--B1", `Content-Type: application/pdf; name="${spec.attachment.name}"`, `Content-Disposition: attachment; filename="${spec.attachment.name}"`, "Content-Transfer-Encoding: base64", "", spec.attachment.base64);
    body = ['Content-Type: multipart/mixed; boundary="B1"', "", ...parts, "--B1--"];
  }
  return new TextEncoder().encode([...head, ...body, ""].join(CRLF));
}

export interface MsgSpec {
  subject?: string;
  body?: string;
  bodyHtml?: string;
  senderName?: string;
  senderSmtp?: string;
  /** Raw transport headers (Message-ID, In-Reply-To, References, From…). */
  headers?: string;
  deliveredAt?: string;
  to?: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  attachments?: Array<{ name: string; size: number }>;
}

const ROOT = 5;
const DIRECTORY = 1;
const DOCUMENT = 2;

const utf16 = (s: string) => {
  const b = new Uint8Array(s.length * 2 + 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = c >> 8;
  }
  return b;
};
const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, "0");
const long = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const systime = (iso: string) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n, true);
  return b;
};
/** `__properties_version1.0`: a header, then 16 bytes per fixed-size property. */
function propertyStream(headerSize: number, fixed: Array<{ tag: number; value: Uint8Array }>, header?: Uint8Array): Uint8Array {
  const out = new Uint8Array(headerSize + 16 * fixed.length);
  if (header) out.set(header, 0);
  const dv = new DataView(out.buffer);
  fixed.forEach((p, i) => {
    const o = headerSize + i * 16;
    dv.setUint32(o, p.tag >>> 0, true);
    dv.setUint32(o + 4, 6, true);
    out.set(p.value, o + 8);
  });
  return out;
}

export function msg(spec: MsgSpec): Uint8Array {
  type Entry = { name: string; type: number; length: number; children?: number[]; binaryProvider?: () => ArrayLike<number> };
  const entries: Entry[] = [{ name: "Root Entry", type: ROOT, length: 0, children: [] }];
  const add = (parent: number, e: Entry) => {
    entries.push(e);
    entries[parent]!.children!.push(entries.length - 1);
    return entries.length - 1;
  };
  const bytes = (parent: number, name: string, data: Uint8Array) => add(parent, { name, type: DOCUMENT, length: data.length, binaryProvider: () => data });
  const str = (parent: number, id: number, text: string | undefined) => {
    if (text !== undefined) bytes(parent, `__substg1.0_${hex(id, 4)}001F`, utf16(text));
  };
  str(0, 0x0037, spec.subject);
  str(0, 0x1000, spec.body);
  if (spec.bodyHtml !== undefined) bytes(0, "__substg1.0_10130102", new TextEncoder().encode(spec.bodyHtml));
  str(0, 0x0c1a, spec.senderName);
  str(0, 0x5d01, spec.senderSmtp);
  str(0, 0x007d, spec.headers);
  const recipients = [...(spec.to ?? []).map((r) => ({ ...r, type: 1 })), ...(spec.cc ?? []).map((r) => ({ ...r, type: 2 }))];
  recipients.forEach((r, i) => {
    const dir = add(0, { name: `__recip_version1.0_#${hex(i, 8)}`, type: DIRECTORY, length: 0, children: [] });
    str(dir, 0x3001, r.name ?? r.email);
    str(dir, 0x39fe, r.email);
    str(dir, 0x3003, r.email);
    str(dir, 0x3002, "SMTP");
    bytes(dir, "__properties_version1.0", propertyStream(8, [{ tag: 0x0c150003, value: long(r.type) }]));
  });
  (spec.attachments ?? []).forEach((a, i) => {
    const dir = add(0, { name: `__attach_version1.0_#${hex(i, 8)}`, type: DIRECTORY, length: 0, children: [] });
    str(dir, 0x3707, a.name);
    str(dir, 0x3704, a.name);
    bytes(dir, "__substg1.0_37010102", new Uint8Array(a.size));
    bytes(dir, "__properties_version1.0", propertyStream(8, [{ tag: 0x0e200003, value: long(a.size) }]));
  });
  const header = new Uint8Array(32);
  const hv = new DataView(header.buffer);
  hv.setUint32(8, recipients.length, true);
  hv.setUint32(12, spec.attachments?.length ?? 0, true);
  hv.setUint32(16, recipients.length, true);
  hv.setUint32(20, spec.attachments?.length ?? 0, true);
  bytes(0, "__properties_version1.0", propertyStream(32, spec.deliveredAt ? [{ tag: 0x0e060040, value: systime(spec.deliveredAt) }] : [], header));
  return burn(entries as Parameters<typeof burn>[0]);
}

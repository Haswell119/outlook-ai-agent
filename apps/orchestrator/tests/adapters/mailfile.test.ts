import { describe, expect, it } from "vitest";
import { detectMailFormat, importanceOf, MailFileError, MAX_MAIL_FILE_BYTES, messageIds, parseMailFile, threadSubject } from "../../src/adapters/mailfile/parse.js";
import { htmlToText } from "../../src/util/text.js";
import { eml, msg } from "../mail-fixtures.js";

const file = (name: string, bytes: Uint8Array, folder?: string) => ({ name, bytes, ...(folder ? { folder } : {}) });

describe("mail files — .eml", () => {
  it("maps a MIME message to the EmailContext a Graph sync would give", async () => {
    const email = await parseMailFile(
      file(
        "facture.eml",
        eml({
          messageId: "<m1@client.example>",
          subject: "=?UTF-8?B?RmFjdHVyZSBkw6lmaSBJQQ==?=",
          to: "=?UTF-8?Q?D=C3=A9fi_IA?= <Defi-IA@Outlook.com>",
          cc: "Autre <autre@client.example>",
          text: "Bonjour, voici la facture à régler avant vendredi.",
          importance: "high",
          attachment: { name: "facture.pdf", base64: "JVBERi0xLjQK" },
        }),
        "Inbox/Fournisseurs",
      ),
    );
    expect(email).toMatchObject({
      internetMessageId: "<m1@client.example>",
      subject: "Facture défi IA",
      from: { name: "Jean Dupont", address: "jean@client.example" },
      to: [{ name: "Défi IA", address: "defi-ia@outlook.com" }],
      cc: [{ name: "Autre", address: "autre@client.example" }],
      sentAt: "2026-09-29T08:05:00.000Z",
      receivedAt: "2026-09-29T08:05:00.000Z",
      body: "Bonjour, voici la facture à régler avant vendredi.",
      importance: "high",
      folder: "Inbox/Fournisseurs",
      attachments: [{ name: "facture.pdf", size: 9, contentType: "application/pdf", isInline: false }],
    });
    expect(email.id).toMatch(/^imp-[0-9a-f]{32}$/);
    expect(email.bodyPreview).toBe("Bonjour, voici la facture à régler avant vendredi.");
  });

  it("an HTML-only body is converted to text", async () => {
    const email = await parseMailFile(file("n.eml", eml({ html: "<style>p{}</style><p>Réunion <b>jeudi</b></p><p>Ordre du jour</p>" })));
    expect(email.body).toBe("Réunion jeudi\nOrdre du jour");
  });

  it("a reply joins the conversation of its thread root; unrelated mail does not", async () => {
    const root = await parseMailFile(file("a.eml", eml({ messageId: "<root@x.example>", subject: "Projet" })));
    const reply = await parseMailFile(file("b.eml", eml({ messageId: "<r1@x.example>", inReplyTo: "<root@x.example>", references: ["<root@x.example>"], subject: "RE: Projet" })));
    const replyToReply = await parseMailFile(file("c.eml", eml({ messageId: "<r2@x.example>", inReplyTo: "<r1@x.example>", references: ["<root@x.example>", "<r1@x.example>"], subject: "RE: RE: Projet" })));
    const other = await parseMailFile(file("d.eml", eml({ messageId: "<o@x.example>", subject: "Projet" })));
    expect(reply.conversationId).toBe(root.conversationId);
    expect(replyToReply.conversationId).toBe(root.conversationId);
    expect(other.conversationId).not.toBe(root.conversationId);
  });

  it("without any Message-ID, the thread falls back to the subject stripped of its prefixes", async () => {
    const a = await parseMailFile(file("a.eml", eml({ subject: "Budget 2027", text: "a" })));
    const b = await parseMailFile(file("b.eml", eml({ subject: "TR : RE: Budget 2027", text: "b" })));
    expect(a.internetMessageId).toBeUndefined();
    expect(b.conversationId).toBe(a.conversationId);
    // Ids then come from the content: two different files never collide.
    expect(a.id).not.toBe(b.id);
  });

  it("the same message imported twice keeps the same id (re-import is idempotent)", async () => {
    const bytes = eml({ messageId: "<same@x.example>" });
    expect((await parseMailFile(file("1.eml", bytes))).id).toBe((await parseMailFile(file("copy of 1.eml", bytes))).id);
  });
});

describe("mail files — .msg", () => {
  const spec = {
    subject: "Facture septembre — Défi IA",
    body: "Bonjour,\r\nvoici la facture.\r\n",
    senderName: "Comptabilité",
    senderSmtp: "Compta@Fournisseur.example",
    headers: "Message-ID: <abc@fournisseur.example>\r\nReferences: <root@fournisseur.example>\r\n <prev@fournisseur.example>\r\nImportance: low\r\n",
    deliveredAt: "2026-09-29T08:15:00Z",
    to: [{ name: "Défi IA", email: "defi-ia@outlook.com" }],
    cc: [{ email: "x@example.com" }],
    attachments: [{ name: "facture.pdf", size: 1234 }],
  };

  it("maps an Outlook message: sender, typed recipients, headers, delivery time, attachments", async () => {
    const email = await parseMailFile(file("facture.msg", msg(spec), "Boîte de réception"));
    expect(email).toMatchObject({
      internetMessageId: "<abc@fournisseur.example>",
      subject: "Facture septembre — Défi IA",
      from: { name: "Comptabilité", address: "compta@fournisseur.example" },
      to: [{ name: "Défi IA", address: "defi-ia@outlook.com" }],
      cc: [{ address: "x@example.com" }],
      receivedAt: "2026-09-29T08:15:00.000Z",
      body: "Bonjour,\nvoici la facture.",
      importance: "low",
      folder: "Boîte de réception",
      attachments: [{ name: "facture.pdf", size: 1234 }],
    });
  });

  it("the same message exported as .msg and as .eml gets the same id and conversation", async () => {
    const fromMsg = await parseMailFile(file("m.msg", msg(spec)));
    const fromEml = await parseMailFile(file("m.eml", eml({ messageId: "<abc@fournisseur.example>", references: ["<root@fournisseur.example>", "<prev@fournisseur.example>"] })));
    expect(fromMsg.id).toBe(fromEml.id);
    expect(fromMsg.conversationId).toBe(fromEml.conversationId);
  });

  it("an Exchange (X.500) sender falls back to the From transport header", async () => {
    const email = await parseMailFile(file("x.msg", msg({ subject: "Interne", body: "x", senderName: "Marie", headers: 'From: "Marie Martin" <marie@contoso.example>\r\n' })));
    expect(email.from).toEqual({ name: "Marie Martin", address: "marie@contoso.example" });
  });

  it("a message handed over as a view on a larger buffer (Node's pooled Buffers) parses the same", async () => {
    const bytes = msg(spec);
    const pool = new Uint8Array(bytes.length + 64);
    pool.set(bytes, 16);
    const email = await parseMailFile(file("v.msg", pool.subarray(16, 16 + bytes.length)));
    expect(email).toMatchObject({ subject: spec.subject, internetMessageId: "<abc@fournisseur.example>" });
  });

  it("an HTML-only Outlook message is converted to text", async () => {
    const email = await parseMailFile(file("h.msg", msg({ subject: "HTML", bodyHtml: "<p>Première ligne</p><p>Deuxième</p>" })));
    expect(email.body).toBe("Première ligne\nDeuxième");
  });
});

describe("mail files — rejected input", () => {
  it("empty, oversized, unknown and fake .msg files are refused with a reason", async () => {
    await expect(parseMailFile(file("e.eml", new Uint8Array()))).rejects.toThrow(new MailFileError("empty file"));
    await expect(parseMailFile(file("big.eml", new Uint8Array(MAX_MAIL_FILE_BYTES + 1)))).rejects.toThrow(/larger than 25 MB/);
    await expect(parseMailFile(file("photo.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])))).rejects.toThrow(/not an \.eml or \.msg/);
    await expect(parseMailFile(file("fake.msg", new TextEncoder().encode("From: a@b.example\r\n\r\nhi")))).rejects.toThrow(/not an \.eml or \.msg/);
    // A compound file that is not a message (e.g. a legacy .doc renamed .msg).
    const notAMessage = msg({});
    notAMessage.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
    await expect(parseMailFile(file("doc.msg", new Uint8Array(512).fill(0).map((_, i) => (i < 8 ? notAMessage[i]! : 0))))).rejects.toThrow(MailFileError);
  });
});

describe("mail files — helpers", () => {
  it("format detection relies on content, the extension is only a hint", () => {
    expect(detectMailFormat("x.bin", msg({ subject: "s" }))).toBe("msg");
    expect(detectMailFormat("noext", new TextEncoder().encode("Received: from a\r\nFrom: a@b.example\r\n"))).toBe("eml");
    expect(detectMailFormat("x.eml", new TextEncoder().encode("hello world"))).toBeUndefined();
  });

  it("message ids, reply prefixes and importance", () => {
    expect(messageIds("<a@x> <b@y>\r\n <c@z>")).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
    expect(threadSubject("RE: TR : Fwd:  Budget   2027")).toBe("budget 2027");
    expect(threadSubject("AW: RE[2]: Offre")).toBe("offre");
    expect(importanceOf("High")).toBe("high");
    expect(importanceOf(undefined, "5 (Lowest)")).toBe("low");
    expect(importanceOf(undefined, "3 (Normal)")).toBe("normal");
    expect(importanceOf()).toBeUndefined();
  });
});

describe("mail files — hostile input stays linear", () => {
  const fast = async (fn: () => unknown, ms = 1500) => {
    const started = performance.now();
    await fn();
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it("HTML: unclosed <style> / <script> blocks and runs of '<' without '>'", async () => {
    await fast(() => expect(htmlToText("<style".repeat(200_000))).toBe(""));
    await fast(() => expect(htmlToText(`<p>ok</p>${"<script".repeat(200_000)}`)).toBe("ok"));
    await fast(() => htmlToText("<".repeat(1_000_000)));
    await fast(() => htmlToText(`<a${" b".repeat(500_000)}`));
    // Same text as before on ordinary bodies.
    expect(htmlToText("<STYLE>p{}</STYLE><p>Hello<br/>world</p><script src=x></script><div>a &amp; b</div>")).toBe("Hello\nworld\na & b");
  });

  it("a 5 MB hostile HTML message, a huge From header and an endless subject", async () => {
    const html = eml({ subject: "Hostile", html: `<p>visible</p>${"<style>".repeat(700_000)}` });
    await fast(async () => expect((await parseMailFile(file("h.eml", html))).body).toBe("visible"), 4000);
    const from = `${"a,".repeat(300_000)}"Marie" <marie@contoso.example>`;
    await fast(async () => {
      const email = await parseMailFile(file("x.msg", msg({ subject: "RE: ".repeat(100_000), body: "x", headers: `From: ${from}\r\n` })));
      expect(email.subject.length).toBeLessThanOrEqual(998);
    }, 4000);
  });
});

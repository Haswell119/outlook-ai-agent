import { describe, expect, it } from "vitest";
import type { EmailContext } from "@oao/shared";
import { coreBodyText, triageAnalysis, triageEmail } from "../../src/domain/triage.js";
import { sampleEmail } from "../helpers.js";

const email = (over: Partial<EmailContext>): EmailContext => sampleEmail({ body: "", attachments: [], ...over });
const INTERNAL = ["northbridge.example"];

describe("triageEmail", () => {
  it("keeps a real business email as a conversation (the model is worth calling)", () => {
    const r = triageEmail(sampleEmail(), { internalDomains: INTERNAL });
    expect(r).toMatchObject({ kind: "conversation", skipModel: false });
  });

  it("detects newsletters from unsubscribe markers (FR and EN)", () => {
    const en = triageEmail(email({ from: { address: "news@marketwatch.example" }, subject: "Weekly market digest", body: "Markets moved.\n\nYou are receiving this email because you subscribed. Unsubscribe here: https://x.example/u?utm_source=nl" }), { internalDomains: INTERNAL });
    expect(en.kind).toBe("newsletter");
    expect(en.skipModel).toBe(true);

    const fr = triageEmail(email({ from: { address: "communication@fintech.example" }, subject: "Votre lettre mensuelle", body: "Voici nos actualités.\n\nPour ne plus recevoir nos messages, cliquez ici pour vous désabonner." }), { internalDomains: INTERNAL });
    expect(fr.kind).toBe("newsletter");
  });

  it("detects robot senders as notifications", () => {
    for (const address of ["noreply@servicedesk.example", "no-reply@bank.example", "notifications@jira.example", "mailer-daemon@mail.example"]) {
      const r = triageEmail(email({ from: { address }, subject: "Ticket OPS-4821 updated", body: "The status changed to In Progress." }), { internalDomains: INTERNAL });
      expect(r.kind, address).toBe("notification");
      expect(r.skipModel, address).toBe(true);
    }
  });

  it("detects out-of-office replies in French and English, even from a human sender", () => {
    const en = triageEmail(email({ from: { name: "Ana Ruiz", address: "ana.ruiz@client.example" }, subject: "Automatic reply: Q2 report", body: "I am out of the office until 3 July with limited access to email." }), { internalDomains: INTERNAL });
    expect(en.kind).toBe("out_of_office");

    const fr = triageEmail(email({ from: { address: "paul.martin@client.example" }, subject: "Absent du bureau", body: "Je suis absent jusqu'au 12 août. En cas d'urgence, contactez mon assistante." }), { internalDomains: INTERNAL });
    expect(fr.kind).toBe("out_of_office");
  });

  it("an out-of-office from a noreply address is an out-of-office, not a notification (ordering matters)", () => {
    const r = triageEmail(email({ from: { address: "noreply@client.example" }, subject: "Out of office: your request", body: "Back on Monday." }), { internalDomains: INTERNAL });
    expect(r.kind).toBe("out_of_office");
  });

  it("detects calendar items from .ics attachments, content type and subject prefixes", () => {
    expect(triageEmail(email({ subject: "Portfolio review", attachments: [{ name: "invite.ics", contentType: "text/calendar" }] }), { internalDomains: INTERNAL }).kind).toBe("calendar");
    expect(triageEmail(email({ subject: "Invitation: Quarterly review @ Thu 12 Jun", body: "When: Thursday\nOrganizer: Jean" }), { internalDomains: INTERNAL }).kind).toBe("calendar");
    expect(triageEmail(email({ subject: "Accepted: Client call", body: "Accepted." }), { internalDomains: INTERNAL }).kind).toBe("calendar");
  });

  it("detects machine-generated messages", () => {
    expect(triageEmail(email({ from: { address: "billing@vendor.example" }, subject: "Invoice 1042", body: "This is an automated message, please do not reply." }), { internalDomains: INTERNAL }).kind).toBe("automatic");
    expect(triageEmail(email({ from: { address: "facture@vendor.example" }, subject: "Facture", body: "Ceci est un message automatique. Merci de ne pas répondre." }), { internalDomains: INTERNAL }).kind).toBe("automatic");
  });

  it("detects trivial acknowledgements in both languages", () => {
    for (const body of ["Thanks!", "Thank you very much", "OK, thanks", "Noted.", "Merci beaucoup", "Bien reçu", "C'est noté", "Bonjour,\n\nParfait.\n\nCordialement,\nJean"]) {
      const r = triageEmail(email({ from: { address: "jean@client.example" }, subject: "Re: Q2 report", body }), { internalDomains: INTERNAL });
      expect(r.kind, body).toBe("trivial");
      expect(r.skipModel, body).toBe(true);
    }
  });

  it("a short message that asks a question is still a conversation", () => {
    const r = triageEmail(email({ from: { address: "jean@client.example" }, subject: "Re: Q2", body: "Thanks — can you confirm the deadline?" }), { internalDomains: INTERNAL });
    expect(r.kind).toBe("conversation");
  });

  it("a short message with an attachment is still a conversation", () => {
    const r = triageEmail(email({ from: { address: "jean@client.example" }, subject: "Signed", body: "Merci.", attachments: [{ name: "mandate.pdf" }] }), { internalDomains: INTERNAL });
    expect(r.kind).toBe("conversation");
  });

  it("an internal colleague's unsubscribe-looking footer is not a newsletter", () => {
    const r = triageEmail(
      email({ from: { name: "Claire", address: "claire.dubois@northbridge.example" }, subject: "Client onboarding update", body: "Hi,\n\nThe KYC pack is still missing two documents; can you chase the client before Friday?\n\nUnsubscribe from this thread by muting it in Outlook." }),
      { internalDomains: INTERNAL },
    );
    expect(r.kind).toBe("conversation");
  });

  it("always returns an honest confidence and a machine-readable reason", () => {
    const r = triageEmail(email({ from: { address: "noreply@x.example" }, subject: "Alert", body: "Disk usage high." }), { internalDomains: INTERNAL });
    expect(r.reason).toMatch(/^sender:/);
    expect(r.confidence).toBeGreaterThan(0.3);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });
});

describe("coreBodyText", () => {
  it("strips greetings and sign-offs so a courtesy-only message reads as empty", () => {
    expect(coreBodyText("Bonjour Marie,\n\nMerci.\n\nCordialement,\nJean")).toBe("");
    expect(coreBodyText("Hi,\n\nThe report is attached.\n\nBest regards,\nAna")).toContain("report is attached");
  });
});

describe("triageAnalysis", () => {
  it("produces a bilingual templated summary with no model call", () => {
    const e = email({ from: { name: "MarketWatch", address: "news@marketwatch.example" }, subject: "Weekly digest", body: "unsubscribe" });
    const triage = triageEmail(e, { internalDomains: INTERNAL });

    const en = triageAnalysis(e, triage, "en");
    expect(en.summary).toContain("MarketWatch");
    expect(en.summary).toContain("Newsletter");
    expect(en.classification.category).toBe("Newsletter");

    const fr = triageAnalysis(e, triage, "fr");
    expect(fr.summary).toMatch(/Newsletter|marketing/);
    expect(fr.classification.category).toBe("Newsletter");
  });

  it("keeps the confidence low but honest and suggests filing / archiving", () => {
    const e = email({ from: { address: "noreply@x.example" }, subject: "Build failed", body: "Pipeline #42 failed." });
    const a = triageAnalysis(e, triageEmail(e, { internalDomains: INTERNAL }), "en");
    expect(a.confidence).toBeLessThanOrEqual(0.6);
    expect(a.confidence).toBeGreaterThan(0.3);
    expect(a.suggestedActions.map((x) => x.type)).toEqual(expect.arrayContaining(["categorize", "archive"]));
  });

  it("an out-of-office produces a follow-up task and reminder", () => {
    const e = email({ from: { name: "Ana", address: "ana@client.example" }, subject: "Automatic reply: mandate", body: "Out of office until 3 July." });
    const a = triageAnalysis(e, triageEmail(e, { internalDomains: INTERNAL }), "en");
    expect(a.pendingTasks.join(" ")).toMatch(/Follow up/i);
    expect(a.suggestedActions.map((x) => x.type)).toContain("create_reminder");
  });

  it("flags an attachment arriving on an automated message", () => {
    const e = email({ from: { address: "noreply@unknown.example" }, subject: "Invoice", body: "See attached.", attachments: [{ name: "invoice.pdf.exe" }] });
    const a = triageAnalysis(e, triageEmail(e, { internalDomains: INTERNAL }), "en");
    expect(a.risks.map((r) => r.code)).toContain("unexpected_attachment");
  });
});

import { describe, expect, it } from "vitest";
import type { EmailContext } from "@oao/shared";
import { MAX_DECISION_OPTIONS, DecisionProviderRequestSchema } from "../../src/domain/decisions/schemas.js";
import { buildFolderQuestion, buildPrimaryQuestions, PRIMARY_QUESTION_IDS, QUESTION_IDS } from "../../src/domain/decisions/question-builder.js";
import { buildDecisionState, CHECKPOINT_STATE_CHAR_BUDGET } from "../../src/domain/decisions/state-builder.js";
import { areaById, loadTaxonomy } from "../../src/domain/decisions/taxonomy.js";
import { sampleEmail } from "../helpers.js";

const taxonomy = loadTaxonomy().taxonomy;

describe("question builder", () => {
  it("builds the four primary questions in French, choice-only, with stable option ids", () => {
    const q = buildPrimaryQuestions(taxonomy, "fr");
    expect(Object.keys(q)).toEqual([...PRIMARY_QUESTION_IDS]);
    for (const question of Object.values(q)) expect(question.type).toBe("choice");
    expect(q.urgency!.instructions).toBe("Détermine le niveau d'urgence métier du message.");
    expect(Object.keys(q.urgency!.criteria)).toEqual(["low", "normal", "high", "critical"]);
    expect(q.urgency!.criteria.critical).toMatch(/Incident de production/);
    expect(Object.keys(q.replyExpected!.criteria)).toEqual(["required", "not_required"]);
    expect(q.replyExpected!.criteria.required).toBe("Une réponse, validation, confirmation ou action est explicitement ou implicitement attendue.");
    expect(Object.keys(q.actionRequired!.criteria)).toEqual(["required", "not_required"]);
    expect(Object.keys(q.businessArea!.criteria)).toEqual(taxonomy.areas.map((a) => a.id));
    expect(q.businessArea!.criteria.operations).toBe("Opérations — Flux opérationnels, NAV, positions, imports et fournisseurs.");
  });

  it("builds the same questions in English, with the same ids", () => {
    const fr = buildPrimaryQuestions(taxonomy, "fr");
    const en = buildPrimaryQuestions(taxonomy, "en");
    expect(en.urgency!.instructions).toBe("Determine the business urgency of the message.");
    expect(en.businessArea!.criteria.operations).toBe("Operations — Operational flows, NAV, positions, imports and providers.");
    for (const id of PRIMARY_QUESTION_IDS) expect(Object.keys(en[id]!.criteria)).toEqual(Object.keys(fr[id]!.criteria));
  });

  it("never uses boolean-looking option ids and never exceeds the option limit", () => {
    for (const lang of ["fr", "en"] as const) {
      for (const question of Object.values(buildPrimaryQuestions(taxonomy, lang))) {
        expect(Object.keys(question.criteria).length).toBeLessThanOrEqual(MAX_DECISION_OPTIONS);
        for (const id of Object.keys(question.criteria)) expect(["true", "false", "yes", "no", "oui", "non"]).not.toContain(id);
      }
    }
  });

  it("asks the folder only among the folders of one area", () => {
    const ops = areaById(taxonomy, "operations")!;
    const q = buildFolderQuestion(ops, "fr");
    expect(Object.keys(q)).toEqual([QUESTION_IDS.folder]);
    expect(Object.keys(q.folder!.criteria)).toEqual(["nav", "sftp"]);
    expect(q.folder!.instructions).toContain("« Opérations »");
    expect(q.folder!.criteria.nav).toBe("Operations/NAV — Imports NAV, valorisations, positions et fichiers associés.");
    // One or zero folder: no question to ask.
    expect(() => buildFolderQuestion(areaById(taxonomy, "accounting")!, "fr")).toThrow(RangeError);
    expect(() => buildFolderQuestion(areaById(taxonomy, "other")!, "en")).toThrow(RangeError);
  });

  it("depends only on the taxonomy and the language — email text cannot reach an instruction or a criterion", () => {
    // The builders take no email at all; building twice is identical and passes the request schema.
    expect(buildPrimaryQuestions(taxonomy, "fr")).toEqual(buildPrimaryQuestions(taxonomy, "fr"));
    const parsed = DecisionProviderRequestSchema.safeParse({ state: {}, questions: buildPrimaryQuestions(taxonomy, "en") });
    expect(parsed.success).toBe(true);
  });

  it("permutes the option order for the evaluation harness, keeping the ids", () => {
    const declared = buildPrimaryQuestions(taxonomy, "en").urgency!.criteria;
    const reversed = buildPrimaryQuestions(taxonomy, "en", { order: "reversed" }).urgency!.criteria;
    const rotated = buildPrimaryQuestions(taxonomy, "en", { order: "rotated" }).urgency!.criteria;
    expect(Object.keys(reversed)).toEqual(["critical", "high", "normal", "low"]);
    expect(Object.keys(rotated)).toEqual(["normal", "high", "critical", "low"]);
    expect(reversed.high).toBe(declared.high);
  });
});

/* -------------------------------------------------------------------------- */

const INTERNAL = ["northbridge.example"];
const now = new Date("2026-09-23T10:00:00.000Z");

const navEmail = (over: Partial<EmailContext> = {}): EmailContext =>
  sampleEmail({
    id: "AAMkAGI2-graph-id",
    conversationId: "conv-secret-id",
    internetMessageId: "<msg@fundadmin.example>",
    webLink: "https://outlook.office.com/owa/?ItemID=abc",
    subject: "Import NAV bloqué pour demain",
    from: { name: "Fund Admin", address: "ops.team@fundadmin.example" },
    to: [{ address: "dev.user@northbridge.example" }],
    cc: [{ address: "cfo@clientco.example" }],
    bcc: [{ address: "hidden@northbridge.example" }],
    receivedAt: "2026-09-23T08:00:00.000Z",
    importance: "high",
    categories: ["Client A"],
    body: "Bonjour,\n\nLe fichier des positions ne pourra pas être livré ce soir. Pouvez-vous confirmer le report ?\n\nCordialement,\nJean Dupont\nFund Admin Ltd | +41 22 000 00 00\n\nLe lun. 22 sept. 2026 à 10:00, Marie Martin a écrit :\n> Ancienne demande sans rapport.\n> Deuxième ligne citée.\n> Troisième ligne citée.",
    attachments: [
      { id: "att-1", name: "Positions 2026-09-22.XLSX", contentType: "application/vnd.ms-excel", textContent: "CONFIDENTIAL ATTACHMENT CONTENT 42" },
      { id: "att-2", name: "logo.png", isInline: true },
    ],
    ...over,
  });

describe("state builder", () => {
  it("keeps only explicit, minimal fields — never the Graph object", () => {
    const { state } = buildDecisionState({ email: navEmail(), language: "fr", internalDomains: INTERNAL, triageKind: "conversation", phishingVerdict: "clean", now }, { maxChars: 4000, model: "multilingual" });
    expect(Object.keys(state)).toEqual(["language", "subject", "senderType", "senderDomain", "recipientCount", "externalRecipients", "importance", "receivedAt", "ageHours", "hasAttachments", "attachments", "categories", "signals", "body"]);
    expect(state).toMatchObject({
      language: "fr",
      subject: "Import NAV bloqué pour demain",
      senderType: "external",
      senderDomain: "fundadmin.example",
      recipientCount: 2, // to + cc; bcc never
      externalRecipients: true,
      importance: "high",
      receivedAt: "2026-09-23T08:00:00.000Z",
      ageHours: 2,
      hasAttachments: true,
      attachments: [{ name: "Positions 2026-09-22.XLSX", extension: "xlsx" }], // inline logo skipped
      categories: ["Client A"],
      signals: { triage: "conversation", phishing: "clean", requestMarkers: true, questionAsked: true },
    });
    const json = JSON.stringify(state);
    for (const leaked of ["AAMkAGI2", "conv-secret-id", "<msg@", "outlook.office.com", "ops.team@", "dev.user@", "cfo@", "hidden@", "att-1", "Fund Admin"]) expect(json).not.toContain(leaked);
  });

  it("never includes attachment content", () => {
    const { state } = buildDecisionState({ email: navEmail(), language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    expect(JSON.stringify(state)).not.toContain("CONFIDENTIAL ATTACHMENT CONTENT");
  });

  it("cleans the body: quoted history and signature removed, zero-width characters stripped", () => {
    const { state } = buildDecisionState({ email: navEmail({ body: `${navEmail().body}\u200b\u202e` }), language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    expect(state.body).toContain("Pouvez-vous confirmer le report ?");
    expect(state.body).not.toContain("Ancienne demande");
    expect(state.body).not.toContain("+41 22");
    expect(state.body).not.toMatch(/[\u200b\u202e]/);
  });

  it("an internal sender has no domain in the state; unknown sender is `unknown`", () => {
    const internal = buildDecisionState({ email: navEmail({ from: { address: "jane@northbridge.example" }, cc: [] }), language: "en", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    expect(internal.state).toMatchObject({ senderType: "internal", externalRecipients: false });
    expect(internal.state).not.toHaveProperty("senderDomain");
    const unknown = buildDecisionState({ email: navEmail({ from: undefined }), language: "en", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    expect(unknown.state.senderType).toBe("unknown");
  });

  it("truncates a long body head + tail within LAYA_INPUT_MAX_CHARS, keeping the latest ask", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `Ligne de contexte numéro ${i} sans importance particulière.`).join("\n");
    const email = navEmail({ body: `Début du message important.\n${filler}\nDernière demande : merci de valider avant 17h.`, attachments: [] });
    const built = buildDecisionState({ email, language: "fr", internalDomains: INTERNAL, now }, { maxChars: 1500 });
    expect(built.stats.truncated).toBe(true);
    expect(built.stats.stateChars).toBeLessThanOrEqual(1500 + 20);
    expect(built.state.body).toMatch(/^Début du message important/);
    expect(built.state.body).toMatch(/merci de valider avant 17h\.$/);
    expect(built.state.body).toContain("[…]");
    // The body is the last field before optional thread excerpts: the engine's own truncation cuts it last.
    expect(Object.keys(built.state).at(-1)).toBe("body");
  });

  it("fits the window of the checkpoint that will read it", () => {
    const email = navEmail({ body: "x ".repeat(5_000), attachments: [] });
    const english = buildDecisionState({ email, language: "en", internalDomains: INTERNAL, now }, { maxChars: 4000, model: "english" });
    const multilingual = buildDecisionState({ email, language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000, model: "multilingual" });
    const unknownModel = buildDecisionState({ email, language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    expect(english.stats.budgetChars).toBe(CHECKPOINT_STATE_CHAR_BUDGET.english);
    expect(english.stats.stateChars).toBeLessThanOrEqual(CHECKPOINT_STATE_CHAR_BUDGET.english! + 20);
    expect(multilingual.stats.stateChars).toBeLessThanOrEqual(CHECKPOINT_STATE_CHAR_BUDGET.multilingual! + 20);
    expect(unknownModel.stats.budgetChars).toBe(4000);
  });

  it("adds at most two short excerpts of the thread, after the body", () => {
    const thread = [1, 2, 3].map((n) => navEmail({ id: `m${n}`, receivedAt: `2026-09-2${n}T08:00:00.000Z`, from: { address: n === 2 ? "a@northbridge.example" : "b@ext.example" }, body: `Message numéro ${n}. ${"détail ".repeat(100)}` }));
    const built = buildDecisionState({ email: navEmail(), language: "fr", internalDomains: INTERNAL, thread, now }, { maxChars: 4000 });
    const prev = built.state.previousMessages as Array<{ senderType: string; excerpt: string }>;
    expect(prev).toHaveLength(2);
    expect(prev.map((p) => p.excerpt.slice(0, 18))).toEqual(["Message numéro 2. ", "Message numéro 3. "]);
    expect(prev[0]!.senderType).toBe("internal");
    for (const p of prev) expect(p.excerpt.length).toBeLessThanOrEqual(200);
    expect(Object.keys(built.state).at(-1)).toBe("previousMessages");
    expect(buildDecisionState({ email: navEmail(), language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 }).state).not.toHaveProperty("previousMessages");
  });

  it("hashes the state deterministically (audit correlation without content)", () => {
    const a = buildDecisionState({ email: navEmail(), language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    const b = buildDecisionState({ email: navEmail(), language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    const c = buildDecisionState({ email: navEmail({ subject: "Autre sujet" }), language: "fr", internalDomains: INTERNAL, now }, { maxChars: 4000 });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

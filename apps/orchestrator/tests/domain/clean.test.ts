import { describe, expect, it } from "vitest";
import type { EmailContext } from "@oao/shared";
import { buildDigest, capHeadTail, cleanBody, collapseWhitespace, estimateTokens, slimThread, stripDisclaimers, stripQuotedHistory, stripSignature, stripTrackingUrls } from "../../src/domain/prompts/clean.js";
import { analysisCacheKey, draftCacheKey, embeddingCacheKey, normalizeForHash, threadCacheKey } from "../../src/domain/cacheKey.js";
import { buildEmailAnalysisPrompt, buildThreadSynthesisPrompt } from "../../src/domain/prompts/index.js";
import { sampleEmail } from "../helpers.js";

const msg = (over: Partial<EmailContext>): EmailContext => sampleEmail({ attachments: [], ...over });

describe("stripQuotedHistory", () => {
  it("cuts at an English 'On … wrote:' marker", () => {
    const r = stripQuotedHistory("Here is my answer.\n\nOn Mon, 3 Jun 2026 at 09:12, Ana Ruiz <ana@client.example> wrote:\n> the original question\n> more of it");
    expect(r.text).toBe("Here is my answer.");
    expect(r.quoted).toContain("wrote:");
  });

  it("cuts at a French 'Le … a écrit :' marker", () => {
    const r = stripQuotedHistory("Voici ma réponse.\n\nLe 3 juin 2026 à 09:12, Ana Ruiz <ana@client.example> a écrit :\n> question initiale");
    expect(r.text).toBe("Voici ma réponse.");
  });

  it("cuts at an Outlook '-----Original Message-----' block", () => {
    const r = stripQuotedHistory("Short reply.\n\n-----Original Message-----\nFrom: Ana\nSent: Monday\nSubject: X\n\nbody");
    expect(r.text).toBe("Short reply.");
  });

  it("cuts at a 'De :' / 'From:' header block", () => {
    const r = stripQuotedHistory("Merci.\n\nDe : Ana Ruiz <ana@client.example>\nEnvoyé : lundi 3 juin\nObjet : mandat\n\ncorps");
    expect(r.text).toBe("Merci.");
  });

  it("cuts at a run of '>' quoted lines", () => {
    const r = stripQuotedHistory("My answer.\n> first\n> second\n> third");
    expect(r.text).toBe("My answer.");
  });

  it("leaves a message without quoted history untouched", () => {
    expect(stripQuotedHistory("Just one paragraph.").text).toBe("Just one paragraph.");
  });
});

describe("stripSignature", () => {
  it("removes a '--' delimited signature at the end", () => {
    const body = `${"Real content. ".repeat(15)}\n--\nJean Dupont\nNorthbridge Capital\nTel: +41 22 000 00 00`;
    const r = stripSignature(body);
    expect(r).not.toContain("Jean Dupont");
    expect(r).toContain("Real content.");
  });

  it("ignores a separator that appears at the very top (it is not a signature)", () => {
    const body = "--\nPlease read the whole document before Friday, it contains the mandate terms.";
    expect(stripSignature(body)).toBe(body);
  });

  it("removes a mobile footer", () => {
    const body = `${"Content here. ".repeat(12)}\nSent from my iPhone`;
    expect(stripSignature(body)).not.toContain("iPhone");
  });
});

describe("stripDisclaimers", () => {
  it("removes English and French confidentiality footers", () => {
    const body = "The mandate is signed.\n\nThis e-mail and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, please delete it.\n\nCe message et ses pièces jointes sont confidentiels. Toute diffusion non autorisée est interdite.";
    const r = stripDisclaimers(body);
    expect(r).toBe("The mandate is signed.");
  });

  it("never returns an empty body when the whole message looks like a disclaimer", () => {
    const body = "This e-mail is confidential and intended solely for the addressee.";
    expect(stripDisclaimers(body)).toBe(body);
  });
});

describe("stripTrackingUrls", () => {
  it("drops utm / click-id parameters but keeps real ones", () => {
    const r = stripTrackingUrls("See https://portal.example/report?id=42&utm_source=news&utm_campaign=q2&gclid=abc");
    expect(r).toContain("id=42");
    expect(r).not.toContain("utm_source");
    expect(r).not.toContain("gclid");
  });

  it("shortens a monstrous tracking URL to its origin and path", () => {
    const long = `https://click.mailer.example/${"a".repeat(400)}`;
    const r = stripTrackingUrls(`Click ${long}`);
    expect(r.length).toBeLessThan(150);
    expect(r).toContain("https://click.mailer.example");
  });
});

describe("collapseWhitespace / capHeadTail", () => {
  it("collapses runs of blank lines, spaces and separator rules", () => {
    expect(collapseWhitespace("a\n\n\n\nb    c\n=======\nd")).toBe("a\n\nb c\n\nd");
  });

  it("keeps the head and the tail when capping (the real ask is often last)", () => {
    const text = `HEAD${"x".repeat(1000)}TAIL`;
    const r = capHeadTail(text, 200);
    expect(r.length).toBeLessThanOrEqual(200);
    expect(r.startsWith("HEAD")).toBe(true);
    expect(r.endsWith("TAIL")).toBe(true);
    expect(r).toContain("[…]");
  });

  it("returns short text unchanged", () => {
    expect(capHeadTail("short", 100)).toBe("short");
  });
});

describe("cleanBody", () => {
  it("runs the whole pipeline and reports the saving", () => {
    const body = [
      "Hi,",
      "",
      "Could you confirm the Q2 deadline? The mandate needs the signed KYC pack.",
      "",
      "Best regards,",
      "Ana Ruiz",
      "--",
      "Ana Ruiz | Client Advisor | Tel: +41 22 000 00 00",
      "",
      "This e-mail and any attachments are confidential and intended solely for the addressee.",
      "",
      "On Mon, 3 Jun 2026 at 09:12, Jean Dupont <jean@northbridge.example> wrote:",
      "> the whole previous conversation",
      "> repeated again",
      "> and again",
    ].join("\n");
    const r = cleanBody(body, { maxChars: 12_000 });
    expect(r.text).toContain("Q2 deadline");
    expect(r.text).not.toContain("confidential and intended");
    expect(r.text).not.toContain("previous conversation");
    expect(r.removed.quoted).toBe(true);
    expect(r.savedRatio).toBeGreaterThan(0.4);
    expect(r.tokens).toBe(Math.ceil(r.chars / 4));
  });

  it("caps at maxChars keeping head and tail", () => {
    const r = cleanBody(`START ${"filler ".repeat(5000)} END`, { maxChars: 1000 });
    expect(r.chars).toBeLessThanOrEqual(1000);
    expect(r.removed.truncated).toBe(true);
    expect(r.text.startsWith("START")).toBe(true);
    expect(r.text.endsWith("END")).toBe(true);
  });

  it("falls back to the quoted text when the message is only a quote", () => {
    const r = cleanBody("On Mon, 3 Jun 2026 at 09:12, Ana <ana@client.example> wrote:\n> Please send the signed mandate.");
    expect(r.text).toContain("signed mandate");
  });

  it("keeps the quoted history when asked to", () => {
    const r = cleanBody("Reply.\n\nOn Mon, 3 Jun 2026, Ana wrote:\n> original", { keepQuoted: true });
    expect(r.text).toContain("original");
  });

  it("estimateTokens is chars/4", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });
});

describe("slimThread", () => {
  const thread = (n: number): EmailContext[] =>
    Array.from({ length: n }, (_, i) =>
      msg({
        id: `m${i}`,
        subject: "Re: Mandate onboarding",
        from: { name: `Person ${i}`, address: `p${i}@client.example` },
        receivedAt: new Date(Date.UTC(2026, 5, 1 + i, 9)).toISOString(),
        // Every reply quotes the previous one: exactly the waste we want gone.
        body: `Message number ${i} with its own specific content about step ${i}.\n\nOn earlier date, someone wrote:\n> Message number ${i - 1} with its own specific content about step ${i - 1}.`,
      }),
    );

  it("keeps only the N most recent messages and digests the rest", () => {
    const r = slimThread(thread(20), { maxMessages: 5, maxChars: 12_000 });
    expect(r.messages).toHaveLength(5);
    expect(r.droppedMessages).toBe(15);
    expect(r.digest).toContain("EARLIER MESSAGES");
    expect(r.digest.split("\n").length).toBeGreaterThan(5);
    // The kept messages are the newest ones, oldest first.
    expect(r.messages[0]!.id).toBe("m15");
    expect(r.messages[4]!.id).toBe("m19");
  });

  it("deduplicates text repeated across the reply chain", () => {
    const r = slimThread(thread(6), { maxMessages: 6, maxChars: 12_000 });
    const joined = r.messages.map((m) => m.body).join("\n");
    const occurrences = joined.split("Message number 4 with its own specific content").length - 1;
    expect(occurrences).toBe(1);
    expect(r.savedRatio).toBeGreaterThan(0.2);
  });

  it("stays within the character budget", () => {
    const big = thread(12).map((m) => ({ ...m, body: "z".repeat(4000) }));
    const r = slimThread(big, { maxMessages: 12, maxChars: 5000 });
    expect(r.chars).toBeLessThanOrEqual(6000);
  });

  it("handles a single message", () => {
    const r = slimThread(thread(1), { maxMessages: 12, maxChars: 12_000 });
    expect(r.messages).toHaveLength(1);
    expect(r.digest).toBe("");
    expect(r.droppedMessages).toBe(0);
  });

  it("buildDigest produces one compact line per message", () => {
    const d = buildDigest(thread(3));
    expect(d.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    for (const line of d.split("\n").filter((l) => l.startsWith("- "))) expect(line.length).toBeLessThanOrEqual(181);
  });
});

describe("prompt builders honour the budget", () => {
  it("email analysis prompt reports slimming stats and shrinks a bloated body", () => {
    const bloated = `Please confirm the deadline.\n\n${"noise ".repeat(5000)}\n\nOn Mon, Ana wrote:\n> ${"old ".repeat(2000)}`;
    const built = buildEmailAnalysisPrompt(msg({ body: bloated }), "en", undefined, { maxChars: 2000, threadMaxMessages: 5 });
    expect(built.stats.chars).toBeLessThanOrEqual(2000);
    expect(built.stats.savedRatio).toBeGreaterThan(0.8);
    expect(built.request.messages.map((m) => m.content).join("").length).toBeLessThan(6000);
  });

  it("thread synthesis prompt digests older messages", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg({ id: `t${i}`, body: `Point ${i} discussed in detail.`, receivedAt: new Date(Date.UTC(2026, 5, 1 + i, 9)).toISOString() }));
    const built = buildThreadSynthesisPrompt({ conversationId: "c", subject: "Long thread", messages }, "en", { maxChars: 8000, threadMaxMessages: 6 });
    expect(built.stats.droppedMessages).toBe(24);
    expect(built.request.messages[1]!.content).toContain("EARLIER MESSAGES");
    expect(built.request.useCase).toBe("thread_synthesis");
  });
});

describe("cache keys", () => {
  const base = { language: "en" as const, promptVersion: "v1" };

  it("normalizeForHash is accent- and case-insensitive", () => {
    expect(normalizeForHash("  Échéance   Vendredi ")).toBe("echeance vendredi");
  });

  it("the same content yields the same analysis key, different content does not", () => {
    const a = analysisCacheKey({ ...base, email: { subject: "Q2 report", body: "Please review.", attachments: [] } });
    const b = analysisCacheKey({ ...base, email: { subject: "q2   REPORT", body: "please review.", attachments: [] } });
    const c = analysisCacheKey({ ...base, email: { subject: "Q2 report", body: "Please review urgently.", attachments: [] } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("quoted history and signatures do not change the key (they are stripped first)", () => {
    const clean = analysisCacheKey({ ...base, email: { subject: "Q2", body: "Please confirm the deadline.", attachments: [] } });
    const noisy = analysisCacheKey({
      ...base,
      email: { subject: "Q2", body: "Please confirm the deadline.\n\nBest regards,\nAna\n--\nAna Ruiz | Tel: +41 22 000 00 00\n\nOn Mon, Jean wrote:\n> older text", attachments: [] },
    });
    expect(noisy).toBe(clean);
  });

  it("language, prompt version and attachment names are part of the key", () => {
    const email = { subject: "Q2", body: "Please review.", attachments: [] };
    expect(analysisCacheKey({ ...base, email })).not.toBe(analysisCacheKey({ ...base, language: "fr", email }));
    expect(analysisCacheKey({ ...base, email })).not.toBe(analysisCacheKey({ ...base, promptVersion: "v2", email }));
    expect(analysisCacheKey({ ...base, email })).not.toBe(analysisCacheKey({ ...base, email: { ...email, attachments: [{ name: "kyc.pdf" }] } }));
  });

  it("attachment order does not matter, inline attachments are ignored", () => {
    const a = analysisCacheKey({ ...base, email: { subject: "s", body: "b", attachments: [{ name: "a.pdf" }, { name: "b.pdf" }] } });
    const b = analysisCacheKey({ ...base, email: { subject: "s", body: "b", attachments: [{ name: "b.pdf" }, { name: "a.pdf" }, { name: "logo.png", isInline: true }] } });
    expect(a).toBe(b);
  });

  it("the thread key changes when a message is added", () => {
    const m1 = { subject: "s", body: "one", attachments: [] };
    const m2 = { subject: "s", body: "two", attachments: [] };
    expect(threadCacheKey({ ...base, subject: "s", messages: [m1] })).not.toBe(threadCacheKey({ ...base, subject: "s", messages: [m1, m2] }));
  });

  it("the draft key depends on intent, tone and instructions", () => {
    const email = { subject: "s", body: "b", attachments: [] };
    const k = (over: Record<string, unknown>) => draftCacheKey({ ...base, email, intent: "accept", tone: "formal", ...over } as Parameters<typeof draftCacheKey>[0]);
    expect(k({})).toBe(k({}));
    expect(k({})).not.toBe(k({ intent: "decline" }));
    expect(k({})).not.toBe(k({ tone: "friendly" }));
    expect(k({})).not.toBe(k({ instructions: "mention the fee" }));
  });

  it("embedding keys are per model", () => {
    expect(embeddingCacheKey("bge-m3", "hello")).not.toBe(embeddingCacheKey("other", "hello"));
    expect(embeddingCacheKey("bge-m3", "hello")).toBe(embeddingCacheKey("bge-m3", "  Hello  "));
  });
});

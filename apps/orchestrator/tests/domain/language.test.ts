import { describe, expect, it } from "vitest";
import { detectLanguage, languageFromAcceptHeader } from "../../src/domain/language.js";
import { bestExcerpt, chunkText, compilePattern, extractDates, levenshtein, queryTerms, toTsQuery } from "../../src/util/text.js";

describe("language detection", () => {
  it("detects French and English", () => {
    expect(detectLanguage("Bonjour, merci de trouver ci-joint le mandat signé pour la validation.")).toBe("fr");
    expect(detectLanguage("Hello, please find attached the signed mandate for your review and approval.")).toBe("en");
  });
  it("falls back on short or ambiguous text", () => {
    expect(detectLanguage("ok", "fr")).toBe("fr");
    expect(detectLanguage("xyz qwe rty", "en")).toBe("en");
  });
  it("parses Accept-Language with quality values", () => {
    expect(languageFromAcceptHeader("fr-CH,fr;q=0.9,en;q=0.8", "en")).toBe("fr");
    expect(languageFromAcceptHeader("de-CH,en-US;q=0.7,fr;q=0.9", "en")).toBe("fr");
    expect(languageFromAcceptHeader("de", "en")).toBe("en");
    expect(languageFromAcceptHeader(undefined, "fr")).toBe("fr");
  });
});

describe("text utils", () => {
  it("levenshtein", () => {
    expect(levenshtein("longbow", "longbovv")).toBe(2);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });
  it("chunkText splits long text with overlap and keeps short text whole", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the mandate onboarding.`).join(" ");
    const chunks = chunkText(long, 500, 50);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 600)).toBe(true);
    expect(chunkText("short", 500)).toEqual(["short"]);
    expect(chunkText("   ")).toEqual([]);
  });
  it("bestExcerpt centres on the densest query window", () => {
    const text = `${"filler ".repeat(100)}We confirm our approval of the mandate as outlined. ${"filler ".repeat(100)}`;
    const ex = bestExcerpt(text, "approval mandate", 40);
    expect(ex).toContain("approval of the mandate");
    expect(ex.startsWith("…")).toBe(true);
  });
  it("queryTerms drops FR/EN stop-words and toTsQuery ORs prefix terms", () => {
    expect(queryTerms("Find the email where the client approved the mandate")).toEqual(["client", "approved", "mandate"]);
    expect(queryTerms("où est le mandat signé ?")).toEqual(["mandat", "signé"]);
    expect(queryTerms("the of")).toEqual(["the", "of"]);
    expect(toTsQuery("Find the email where the client approved the mandate")).toBe("clie:* | approv:* | manda:*");
    expect(toTsQuery("kyc ok")).toBe("kyc | ok");
    expect(toTsQuery("")).toBe("");
  });
  it("compilePattern supports the (?i) inline flag and rejects invalid regex", () => {
    expect(compilePattern("(?i)\\bpassword\\b")?.test("PASSWORD")).toBe(true);
    expect(compilePattern("(")).toBeUndefined();
  });
  it("extractDates finds ISO, numeric and textual FR/EN dates", () => {
    const d = extractDates("Deadline 2025-05-30, sinon le 26 mai 2025 ou June 15th, 2025 et 30/05/2025");
    expect(d).toEqual(expect.arrayContaining(["2025-05-30", "26 mai 2025", "June 15th, 2025", "30/05/2025"]));
  });
});

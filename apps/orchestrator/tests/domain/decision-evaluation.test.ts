import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MockDecisionProvider } from "../../src/adapters/decision/mock.js";
import { evaluate, evaluateQuestion, expectedChoice, NO_ANSWER, parseDataset, percentile, renderMarkdown, type EvalCase } from "../../src/domain/decisions/evaluation.js";
import { loadTaxonomy } from "../../src/domain/decisions/taxonomy.js";
import { EmailDecisionService } from "../../src/services/EmailDecisionService.js";
import { sampleEmail } from "../helpers.js";

const EXAMPLE = fileURLToPath(new URL("../../../../evaluation/laya/example-dataset.jsonl", import.meta.url));
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as never;

const kase = (id: string, expected: EvalCase["expected"], predicted: EvalCase["predicted"], extra: Partial<EvalCase> = {}): EvalCase => ({ id, expected, predicted, latencyMs: 100, ...extra });

describe("evaluation dataset", () => {
  it("parses JSON Lines, skips blanks and comments, reports every bad line with its number", () => {
    const text = [
      '{"id":"a","email":{"subject":"s","body":"b"},"expected":{"urgency":"high"}}',
      "",
      "// a comment",
      "{not json",
      '{"id":"b","email":{},"expected":{"urgency":"extreme"}}',
      '{"id":"c","email":{},"expected":{"colour":"blue"}}',
      '{"id":"a","email":{},"expected":{}}',
    ].join("\n");
    const { records, errors } = parseDataset(text);
    expect(records.map((r) => r.id)).toEqual(["a"]);
    expect(records[0]!.readerLanguage).toBe("fr");
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/^line 4: not valid JSON/);
    expect(errors[1]).toMatch(/^line 5: expected.urgency/);
    expect(errors[2]).toMatch(/^line 6: .*colour/);
    expect(errors[3]).toBe('line 7: duplicate id "a"');
  });

  it("annotations map to the engine's choice ids", () => {
    expect(expectedChoice({ replyExpected: true }, "replyExpected")).toBe("required");
    expect(expectedChoice({ actionRequired: false }, "actionRequired")).toBe("not_required");
    expect(expectedChoice({ businessArea: "operations" }, "businessArea")).toBe("operations");
    expect(expectedChoice({}, "folder")).toBeUndefined();
  });

  it("the committed example is synthetic, valid, and consistent with the example taxonomy", () => {
    const { records, errors } = parseDataset(readFileSync(EXAMPLE, "utf8"));
    expect(errors).toEqual([]);
    expect(records.length).toBeGreaterThanOrEqual(20);
    const taxonomy = loadTaxonomy().taxonomy;
    const areas = new Map(taxonomy.areas.map((a) => [a.id, new Set(a.folders.map((f) => f.id))]));
    for (const r of records) {
      expect(r.id).toMatch(/^syn-\d{3}$/);
      const area = r.expected.businessArea;
      if (area) expect(areas.has(area), `${r.id}: unknown area ${area}`).toBe(true);
      if (r.expected.folder) expect(areas.get(area!)?.has(r.expected.folder), `${r.id}: folder ${r.expected.folder} not in ${area}`).toBe(true);
      // Synthetic only: reserved example domains, never a real mailbox.
      for (const a of [r.email.from?.address, ...r.email.to.map((t) => t.address)]) if (a) expect(a).toMatch(/\.example$/);
    }
    // Every area of the taxonomy is represented, in both languages.
    expect(new Set(records.map((r) => r.expected.businessArea))).toEqual(new Set(taxonomy.areas.map((a) => a.id)));
    expect(new Set(records.map((r) => r.readerLanguage))).toEqual(new Set(["fr", "en"]));
  });
});

describe("evaluation metrics", () => {
  const cases = [
    kase("1", { businessArea: "ops" }, { businessArea: { choice: "ops", confidence: 0.9, accepted: true } }),
    kase("2", { businessArea: "ops" }, { businessArea: { choice: "other", confidence: 0.6, accepted: false } }),
    kase("3", { businessArea: "other" }, { businessArea: { choice: "other", confidence: 0.8, accepted: true } }),
    kase("4", { businessArea: "ops" }, {}, { failure: "timeout", latencyMs: 5000 }),
    kase("5", {}, { businessArea: { choice: "ops", confidence: 0.99, accepted: true } }),
  ];

  it("accuracy counts a missing answer as wrong; coverage and accepted accuracy follow the gate", () => {
    const r = evaluateQuestion(cases, "businessArea", [0.5, 0.85]);
    expect(r.labelled).toBe(4);
    expect(r.answered).toBe(3);
    expect(r.accuracy).toBe(0.5);
    expect(r.coverage).toBe(0.5);
    expect(r.acceptedAccuracy).toBe(1);
    expect(r.fallbackRate).toBe(0.5);
    expect(r.meanConfidenceCorrect).toBeCloseTo(0.85);
    expect(r.meanConfidenceIncorrect).toBeCloseTo(0.6);
    expect(r.confusion).toEqual({ ops: { ops: 1, other: 1, [NO_ANSWER]: 1 }, other: { other: 1 } });
    expect(r.sweep).toEqual([
      { threshold: 0.5, coverage: 0.75, acceptedAccuracy: 2 / 3 },
      { threshold: 0.85, coverage: 0.25, acceptedAccuracy: 1 },
    ]);
    expect(r.stability).toBeNull();
  });

  it("stability is the share of emails whose answer survived the option permutations", () => {
    const r = evaluateQuestion(
      [
        kase("1", { urgency: "high" }, { urgency: { choice: "high", confidence: 0.9, accepted: true } }, { stable: { urgency: true } }),
        kase("2", { urgency: "low" }, { urgency: { choice: "normal", confidence: 0.5, accepted: false } }, { stable: { urgency: false } }),
      ],
      "urgency",
    );
    expect(r.stability).toBe(0.5);
  });

  it("latency percentiles ignore failed emails; folder accuracy is measured given a correct, accepted area", () => {
    const report = evaluate([
      ...cases,
      kase("6", { businessArea: "ops", folder: "nav" }, { businessArea: { choice: "ops", confidence: 0.9, accepted: true }, folder: { choice: "nav", confidence: 0.9, accepted: true } }, { latencyMs: 300 }),
      kase("7", { businessArea: "ops", folder: "sftp" }, { businessArea: { choice: "ops", confidence: 0.9, accepted: true }, folder: { choice: "nav", confidence: 0.9, accepted: true } }, { latencyMs: 200 }),
    ]);
    expect(report.cases).toBe(7);
    expect(report.failures).toBe(1);
    expect(report.latency).toEqual({ p50: 100, p95: 300, max: 300 });
    expect(report.folderGivenCorrectArea).toBe(0.5);
    expect(report.questions.map((q) => q.question)).toEqual(["urgency", "businessArea", "folder", "replyExpected", "actionRequired"]);
  });

  it("nearest-rank percentile", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("the Markdown report carries the figures and the caveats", () => {
    const md = renderMarkdown(evaluate(cases), { dataset: "x.jsonl", provider: "mock" });
    expect(md).toContain("| businessArea | 4 | 50.0 % | 50.0 % | 100.0 % | 50.0 % |");
    expect(md).toContain("## Threshold sweep");
    expect(md).toContain("### businessArea");
    expect(md).toContain("not a probability of being right");
    expect(md).toContain("kept out of Git");
  });
});

describe("option-order permutations (evaluation only)", () => {
  it("reorders the options sent to the engine; production keeps the declared order", async () => {
    const taxonomy = loadTaxonomy();
    const mock = new MockDecisionProvider();
    const service = new EmailDecisionService({
      provider: mock,
      settings: { provider: "mock", mode: "active", minConfidence: 0.75, folderMinConfidence: 0.8, fallbackToLlm: true, inputMaxChars: 4000, modelStrategy: "language", shadowSampleRate: 1, decisionVersion: "v1", concurrency: 1 },
      taxonomy,
      logger: quiet,
    });
    const input = { email: sampleEmail({ subject: "Import NAV bloqué", body: "Le fichier NAV des positions est bloqué, pouvez-vous relancer ?", attachments: [] }), readerLanguage: "fr" as const, internalDomains: ["northbridge.example"], triageKind: "conversation" as const, phishingVerdict: "clean" as const };
    const declared = await service.decide(input);
    const reversed = await service.decide({ ...input, optionOrder: "reversed" });
    const areaOptions = (i: number) => Object.keys(mock.requests[i]!.questions.businessArea!.criteria);
    const firstOfReversed = declared.calls; // index of the reversed run's first request
    expect(areaOptions(firstOfReversed)).toEqual([...areaOptions(0)].reverse());
    // Same answers whatever the order (the mock has no position bias).
    expect(reversed.questions.businessArea?.choice).toBe(declared.questions.businessArea?.choice);
    expect(reversed.questions.folder?.choice).toBe(declared.questions.folder?.choice);
  });
});

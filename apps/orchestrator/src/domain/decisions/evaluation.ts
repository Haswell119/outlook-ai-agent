import { z } from "zod";
import { UrgencyLevelSchema } from "@oao/shared";

/**
 * Evaluation of the structured decisions against an annotated dataset — pure
 * functions, no I/O (the runner is `src/scripts/evaluate-laya.ts`).
 *
 * What it measures, per question (urgency, businessArea, folder,
 * replyExpected, actionRequired):
 *  - accuracy          engine argmax vs the annotation, over every labelled email
 *                      (no answer = wrong);
 *  - coverage          share of labelled emails whose answer passed the
 *                      confidence threshold (what active mode would use);
 *  - accepted accuracy accuracy on that covered share only — the number that
 *                      matters for active mode;
 *  - fallback rate     1 − coverage (the LLM / rules take over);
 *  - mean confidence   of correct vs incorrect answers (a large gap = the gate
 *                      separates well; none = the confidence is not usable);
 *  - confusion matrix  annotation → answer;
 *  - threshold sweep   coverage / accepted accuracy at several thresholds;
 *  - stability         share of emails whose answer is unchanged when the
 *                      options are presented in another order (position bias).
 * Plus latency p50 / p95 (engine time per email) and failures.
 *
 * The folder is decided hierarchically, exactly as in production: it is only
 * asked when the area passed its threshold, so the folder figures are
 * end-to-end ("would the right folder have been proposed?").
 *
 * High confidence is not correctness: these figures are only as good as the
 * annotations, and only valid for emails that look like the dataset.
 */

export const EVAL_QUESTIONS = ["urgency", "businessArea", "folder", "replyExpected", "actionRequired"] as const;
export type EvalQuestion = (typeof EVAL_QUESTIONS)[number];

/** Choice id meaning "not answered" in the confusion matrix. */
export const NO_ANSWER = "(none)";

export const DEFAULT_SWEEP = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;

/* -------------------------------------------------------------------------- */
/*  Dataset                                                                   */
/* -------------------------------------------------------------------------- */

const address = z.object({ name: z.string().optional(), address: z.string() });

/** One annotated email (JSON Lines). Only synthetic examples are committed. */
export const EvalRecordSchema = z
  .object({
    id: z.string().min(1).max(120),
    /** Reader language (labels); the email language is detected, like in production. */
    readerLanguage: z.enum(["fr", "en"]).default("fr"),
    email: z.object({
      subject: z.string().default(""),
      from: address.optional(),
      to: z.array(address).default([]),
      cc: z.array(address).default([]),
      body: z.string().default(""),
      receivedAt: z.string().optional(),
      importance: z.enum(["low", "normal", "high"]).optional(),
      attachments: z.array(z.object({ name: z.string(), contentType: z.string().optional(), size: z.number().optional() })).default([]),
    }),
    expected: z
      .object({
        urgency: UrgencyLevelSchema.optional(),
        businessArea: z.string().optional(),
        folder: z.string().optional(),
        replyExpected: z.boolean().optional(),
        actionRequired: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type EvalRecord = z.infer<typeof EvalRecordSchema>;

/** Parse JSON Lines; every problem is reported with its line number. */
export function parseDataset(text: string): { records: EvalRecord[]; errors: string[] } {
  const records: EvalRecord[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (e) {
      errors.push(`line ${i + 1}: not valid JSON (${(e as Error).message})`);
      return;
    }
    const parsed = EvalRecordSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(`line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join(".") || "$"}: ${x.message}`).join("; ")}`);
      return;
    }
    if (seen.has(parsed.data.id)) {
      errors.push(`line ${i + 1}: duplicate id "${parsed.data.id}"`);
      return;
    }
    seen.add(parsed.data.id);
    records.push(parsed.data);
  });
  return { records, errors };
}

/** Annotation → choice id, as the engine answers it. */
export function expectedChoice(expected: EvalRecord["expected"], q: EvalQuestion): string | undefined {
  const v = expected[q];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v ? "required" : "not_required";
  return v;
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                   */
/* -------------------------------------------------------------------------- */

export interface EvalPrediction {
  /** Raw engine choice (argmax), accepted or not. */
  choice?: string;
  confidence?: number;
  /** Passed the configured threshold. */
  accepted: boolean;
}

export interface EvalCase {
  id: string;
  expected: EvalRecord["expected"];
  predicted: Partial<Record<EvalQuestion, EvalPrediction>>;
  /** Engine time for this email (all calls). */
  latencyMs: number;
  /** Error class when the engine failed for this email. */
  failure?: string;
  /** Per question: was the choice identical under every option order tried? */
  stable?: Partial<Record<EvalQuestion, boolean>>;
}

export interface SweepPoint {
  threshold: number;
  coverage: number;
  acceptedAccuracy: number | null;
}

export interface QuestionReport {
  question: EvalQuestion;
  labelled: number;
  answered: number;
  accuracy: number | null;
  coverage: number | null;
  acceptedAccuracy: number | null;
  fallbackRate: number | null;
  meanConfidenceCorrect: number | null;
  meanConfidenceIncorrect: number | null;
  /** expected → predicted → count. */
  confusion: Record<string, Record<string, number>>;
  sweep: SweepPoint[];
  /** Share of labelled emails with a stable answer; null when permutations were not run. */
  stability: number | null;
}

export interface EvalReport {
  cases: number;
  failures: number;
  latency: { p50: number | null; p95: number | null; max: number | null };
  questions: QuestionReport[];
  /** Folder correct among the emails whose area was answered correctly and accepted. */
  folderGivenCorrectArea: number | null;
}

const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Nearest-rank percentile (p in 0..100) of a sample; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export function evaluateQuestion(cases: EvalCase[], q: EvalQuestion, sweep: readonly number[] = DEFAULT_SWEEP): QuestionReport {
  let labelled = 0;
  let answered = 0;
  let correct = 0;
  let covered = 0;
  let coveredCorrect = 0;
  let stableCount = 0;
  let stabilityKnown = 0;
  const confCorrect: number[] = [];
  const confIncorrect: number[] = [];
  const confusion: Record<string, Record<string, number>> = {};
  const scored: Array<{ confidence: number; ok: boolean }> = [];

  for (const c of cases) {
    const want = expectedChoice(c.expected, q);
    if (want === undefined) continue;
    labelled++;
    const p = c.predicted[q];
    const got = p?.choice ?? NO_ANSWER;
    (confusion[want] ??= {})[got] = (confusion[want]![got] ?? 0) + 1;
    if (c.stable?.[q] !== undefined) {
      stabilityKnown++;
      if (c.stable[q]) stableCount++;
    }
    if (!p?.choice) continue;
    answered++;
    const ok = p.choice === want;
    if (ok) correct++;
    if (p.accepted) {
      covered++;
      if (ok) coveredCorrect++;
    }
    if (typeof p.confidence === "number") {
      (ok ? confCorrect : confIncorrect).push(p.confidence);
      scored.push({ confidence: p.confidence, ok });
    }
  }

  const coverage = ratio(covered, labelled);
  return {
    question: q,
    labelled,
    answered,
    accuracy: ratio(correct, labelled),
    coverage,
    acceptedAccuracy: ratio(coveredCorrect, covered),
    fallbackRate: coverage === null ? null : 1 - coverage,
    meanConfidenceCorrect: mean(confCorrect),
    meanConfidenceIncorrect: mean(confIncorrect),
    confusion,
    sweep: sweep.map((threshold) => {
      const above = scored.filter((s) => s.confidence >= threshold);
      return { threshold, coverage: labelled ? above.length / labelled : 0, acceptedAccuracy: ratio(above.filter((s) => s.ok).length, above.length) };
    }),
    stability: ratio(stableCount, stabilityKnown),
  };
}

export function evaluate(cases: EvalCase[], sweep: readonly number[] = DEFAULT_SWEEP): EvalReport {
  const latencies = cases.filter((c) => !c.failure).map((c) => c.latencyMs);
  const areaRight = cases.filter((c) => {
    const want = expectedChoice(c.expected, "businessArea");
    const p = c.predicted.businessArea;
    return want !== undefined && p?.accepted && p.choice === want && expectedChoice(c.expected, "folder") !== undefined;
  });
  const folderRight = areaRight.filter((c) => c.predicted.folder?.choice === expectedChoice(c.expected, "folder"));
  return {
    cases: cases.length,
    failures: cases.filter((c) => c.failure).length,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    questions: EVAL_QUESTIONS.map((q) => evaluateQuestion(cases, q, sweep)),
    folderGivenCorrectArea: ratio(folderRight.length, areaRight.length),
  };
}

/* -------------------------------------------------------------------------- */
/*  Markdown                                                                  */
/* -------------------------------------------------------------------------- */

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);
const num = (v: number | null, digits = 2): string => (v === null ? "—" : v.toFixed(digits));

export function renderMarkdown(report: EvalReport, meta: Record<string, string | number | boolean>): string {
  const out: string[] = [];
  out.push("# Laya — evaluation report", "");
  for (const [k, v] of Object.entries(meta)) out.push(`- **${k}**: ${v}`);
  out.push(
    `- **emails**: ${report.cases} (engine failures: ${report.failures})`,
    `- **latency per email** (engine time): p50 ${num(report.latency.p50, 0)} ms · p95 ${num(report.latency.p95, 0)} ms · max ${num(report.latency.max, 0)} ms`,
    `- **folder given a correct, accepted area**: ${pct(report.folderGivenCorrectArea)}`,
    "",
    "| question | labelled | accuracy | coverage (≥ threshold) | accuracy when accepted | fallback | mean conf. correct / incorrect | stability |",
    "|---|---:|---:|---:|---:|---:|---|---:|",
  );
  for (const q of report.questions) {
    out.push(`| ${q.question} | ${q.labelled} | ${pct(q.accuracy)} | ${pct(q.coverage)} | ${pct(q.acceptedAccuracy)} | ${pct(q.fallbackRate)} | ${num(q.meanConfidenceCorrect)} / ${num(q.meanConfidenceIncorrect)} | ${pct(q.stability)} |`);
  }
  out.push("", "## Threshold sweep (coverage → accuracy when accepted)", "");
  const thresholds = report.questions[0]?.sweep.map((s) => s.threshold) ?? [];
  out.push(`| question | ${thresholds.map((t) => `≥ ${t}`).join(" | ")} |`, `|---|${thresholds.map(() => "---").join("|")}|`);
  for (const q of report.questions) out.push(`| ${q.question} | ${q.sweep.map((s) => `${pct(s.coverage)} → ${pct(s.acceptedAccuracy)}`).join(" | ")} |`);
  out.push("", "## Confusion matrices (annotation → answer)", "");
  for (const q of report.questions) {
    if (!q.labelled) continue;
    const predicted = [...new Set(Object.values(q.confusion).flatMap((row) => Object.keys(row)))].sort();
    out.push(`### ${q.question}`, "", `| expected \\ answered | ${predicted.join(" | ")} |`, `|---|${predicted.map(() => "---:").join("|")}|`);
    for (const [want, row] of Object.entries(q.confusion).sort()) out.push(`| ${want} | ${predicted.map((p) => row[p] ?? 0).join(" | ")} |`);
    out.push("");
  }
  out.push(
    "## Reading this report",
    "",
    "- Confidence is the engine's certainty over the options it was given (normalised entropy), not a probability of being right: a high confidence can still be wrong.",
    "- Pick thresholds from the sweep on *your* annotated emails; the figures do not transfer to other mailboxes, other languages or another taxonomy.",
    "- A synthetic dataset only checks the plumbing. Decide on active mode from a real, representative, annotated dataset — kept out of Git.",
  );
  return out.join("\n");
}

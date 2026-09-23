/**
 * `npm run eval:laya` — evaluate the structured decisions on an annotated
 * dataset, through the production code path (`EmailDecisionService`: same
 * state, same questions, same hierarchy, same confidence gate).
 *
 *   npm run eval:laya                                   # synthetic example, needs a running Laya
 *   npm run eval:laya -- --provider mock                # plumbing only, no engine
 *   npm run eval:laya -- --dataset evaluation/laya/private/annotated.jsonl
 *   npm run eval:laya -- --no-permutations --limit 50
 *
 * Reads the LAYA_* settings like the server (environment, then
 * apps/orchestrator/.env, then the root .env): LAYA_BASE_URL, LAYA_API_KEY(_FILE),
 * LAYA_TAXONOMY_FILE, LAYA_MIN_CONFIDENCE, LAYA_FOLDER_MIN_CONFIDENCE,
 * LAYA_MODEL_STRATEGY… `--min-confidence` / `--folder-min-confidence` override.
 *
 * Prints a Markdown report and writes it, with the per-email predictions (ids,
 * annotations and answers — never the email text), under
 * evaluation/laya/results/ (git-ignored). The real annotated dataset must stay
 * out of Git: keep it under evaluation/laya/private/ (git-ignored).
 */
import "../env-file.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailContextSchema, type EmailContext } from "@oao/shared";
import { createDecisionProvider, MockDecisionProvider } from "../adapters/decision/index.js";
import { ConfigError, loadConfig } from "../config.js";
import { assessPhishing } from "../domain/compliance/phishing.js";
import { evaluate, EVAL_QUESTIONS, parseDataset, renderMarkdown, type EvalCase, type EvalPrediction, type EvalQuestion, type EvalRecord } from "../domain/decisions/evaluation.js";
import type { OptionOrder } from "../domain/decisions/question-builder.js";
import { loadTaxonomy } from "../domain/decisions/taxonomy.js";
import { triageEmail } from "../domain/triage.js";
import { decisionSettings, EmailDecisionService, type DecisionOutcome } from "../services/EmailDecisionService.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

const HELP = `Usage: npm run eval:laya -- [options]

  --dataset <file>              JSON Lines, one annotated email per line
                                (default evaluation/laya/example-dataset.jsonl — synthetic)
  --provider <laya|mock>        laya (default): the engine at LAYA_BASE_URL; mock: plumbing only
  --min-confidence <0..1>       override LAYA_MIN_CONFIDENCE
  --folder-min-confidence <0..1> override LAYA_FOLDER_MIN_CONFIDENCE
  --no-permutations             skip the option-order stability runs (3x fewer calls)
  --limit <n>                   first n emails only
  --out <dir>                   report directory (default evaluation/laya/results)
  --help                        this help
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const provider = args.provider === "mock" ? "mock" : "laya";
const datasetPath = path.resolve(repoRoot, typeof args.dataset === "string" ? args.dataset : "evaluation/laya/example-dataset.jsonl");
const outDir = path.resolve(repoRoot, typeof args.out === "string" ? args.out : "evaluation/laya/results");
const permutations: OptionOrder[] = args["no-permutations"] ? [] : ["reversed", "rotated"];
const limit = typeof args.limit === "string" ? Number(args.limit) : Number.POSITIVE_INFINITY;

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, fatal: () => undefined, trace: () => undefined, child: () => quiet } as never;

let cfg;
try {
  cfg = loadConfig({
    ...process.env,
    // A CLI run: none of the server's production requirements apply.
    NODE_ENV: "development",
    DECISION_PROVIDER: provider,
    LAYA_MODE: "active",
    ...(typeof args["min-confidence"] === "string" ? { LAYA_MIN_CONFIDENCE: args["min-confidence"] } : {}),
    ...(typeof args["folder-min-confidence"] === "string" ? { LAYA_FOLDER_MIN_CONFIDENCE: args["folder-min-confidence"] } : {}),
  });
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`configuration error:\n  - ${e.problems.join("\n  - ")}`);
    process.exit(2);
  }
  throw e;
}

const { records, errors } = parseDataset(await readFile(datasetPath, "utf8"));
if (errors.length) {
  console.error(`${path.relative(repoRoot, datasetPath)}: ${errors.length} invalid line(s)\n  - ${errors.slice(0, 20).join("\n  - ")}`);
  process.exit(2);
}
const selected = records.slice(0, limit);
const taxonomy = loadTaxonomy(cfg.LAYA_TAXONOMY_FILE);
const engine = provider === "mock" ? new MockDecisionProvider() : createDecisionProvider(cfg, { logger: quiet }, undefined, true).provider;

if (engine.healthCheck) {
  const h = await engine.healthCheck();
  console.error(`engine: ${provider} ${provider === "laya" ? cfg.LAYA_BASE_URL : ""} → ${h.status}${h.detail ? ` (${h.detail})` : ""}`);
  if (provider === "laya" && h.status === "unavailable") {
    console.error("Laya is not reachable: start it (docker compose --profile laya up) or use --provider mock to check the harness.");
    process.exit(1);
  }
}

const settings = { ...decisionSettings(cfg), mode: "active" as const };
const service = new EmailDecisionService({ provider: engine, settings, taxonomy, logger: quiet });
const internalDomains = cfg.INTERNAL_DOMAINS;

function toEmail(r: EvalRecord): EmailContext {
  return EmailContextSchema.parse({ id: r.id, conversationId: `eval-${r.id}`, ...r.email });
}

const predictions = (o: DecisionOutcome): Partial<Record<EvalQuestion, EvalPrediction>> =>
  Object.fromEntries(
    EVAL_QUESTIONS.flatMap((q) => {
      const t = o.questions[q];
      return t ? [[q, { choice: t.choice, confidence: t.confidence, accepted: t.accepted }]] : [];
    }),
  );

const cases: EvalCase[] = [];
let done = 0;
for (const r of selected) {
  const email = toEmail(r);
  const base = {
    email,
    readerLanguage: r.readerLanguage,
    internalDomains,
    triageKind: triageEmail(email, { internalDomains }).kind,
    phishingVerdict: assessPhishing(email, { internalDomains }).verdict,
    correlationId: `eval-${r.id}`,
  };
  const outcome = await service.decide(base);
  const c: EvalCase = { id: r.id, expected: r.expected, predicted: predictions(outcome), latencyMs: outcome.latencyMs, ...(outcome.status === "failed" ? { failure: outcome.failureKind ?? "failed" } : {}) };
  if (permutations.length && outcome.status === "ok") {
    const runs = [outcome];
    for (const optionOrder of permutations) runs.push(await service.decide({ ...base, optionOrder }));
    c.stable = Object.fromEntries(EVAL_QUESTIONS.map((q) => [q, runs.every((x) => x.status === "ok" && x.questions[q]?.choice === outcome.questions[q]?.choice)]));
  }
  cases.push(c);
  done++;
  if (done % 10 === 0) console.error(`… ${done}/${selected.length}`);
}

const report = evaluate(cases);
const meta = {
  dataset: path.relative(repoRoot, datasetPath),
  provider: provider === "laya" ? `laya (${cfg.LAYA_BASE_URL})` : "mock (plumbing only — not a quality measure)",
  "model strategy": `${cfg.LAYA_MODEL_STRATEGY}${cfg.LAYA_FIXED_MODEL ? ` (${cfg.LAYA_FIXED_MODEL})` : ""}`,
  thresholds: `decision ${cfg.LAYA_MIN_CONFIDENCE} · folder ${cfg.LAYA_FOLDER_MIN_CONFIDENCE}`,
  taxonomy: `${taxonomy.taxonomy.version} (${taxonomy.hash.slice(0, 12)}${taxonomy.example ? ", bundled example" : ""})`,
  "decision version": cfg.LAYA_DECISION_VERSION,
  permutations: permutations.length ? `declared + ${permutations.join(" + ")}` : "off",
  date: new Date().toISOString(),
};
const markdown = renderMarkdown(report, meta);
console.log(markdown);

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = path.join(outDir, `${stamp}-${provider}`);
// Ids, annotations and answers only: the email text never leaves the dataset file.
await writeFile(`${base}.json`, `${JSON.stringify({ meta, report, cases }, null, 2)}\n`, "utf8");
await writeFile(`${base}.md`, `${markdown}\n`, "utf8");
console.error(`\nreport written to ${path.relative(repoRoot, base)}.{md,json}`);

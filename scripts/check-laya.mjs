#!/usr/bin/env node
/**
 * `npm run check:laya` — checks a running Laya (laya-serve) directly, without
 * going through the orchestrator:
 *
 *   1. GET  {LAYA_BASE_URL}/health        reachability, loaded checkpoints, device
 *   2. POST {LAYA_BASE_URL}/v1/systemone  one decision on a synthetic email, with
 *                                         the orchestrator's real questions (taxonomy,
 *                                         FR/EN criteria) when apps/orchestrator is built
 *
 * The full flow (orchestrator + Laya + synthetic email + log hygiene) is
 * `npm run smoke:laya -- --laya-url <url>`.
 *
 * Reads LAYA_BASE_URL / LAYA_API_KEY (or LAYA_API_KEY_FILE) from .env — a real
 * environment variable always wins. The key is never printed. No email content
 * is sent: the state is synthetic.
 *
 * Exit code 0 = usable engine, 1 = blocking problem.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fail, helpIfRequested, info, loadEnv, ok, parseArgs, repoRoot, request, step, warn } from "./lib/common.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), { booleans: ["help", "h", "json"] });

helpIfRequested(
  flags,
  `
Usage: npm run check:laya -- [path-to-env-file] [options]

  1. GET  {LAYA_BASE_URL}/health
  2. POST {LAYA_BASE_URL}/v1/systemone   (synthetic email, real questions)

Options:
  --url <url>        engine base URL (default $LAYA_BASE_URL; "laya:8000" is
                     rewritten to localhost:8000 when run from the host)
  --model <name>     checkpoint to ask (english | multilingual; default multilingual)
  --lang <fr|en>     language of the synthetic email and questions (default fr)
  --timeout <ms>     per-request timeout (default 30000 — a cold CPU load is slow)
  -h, --help         show this help

Default env file: ./.env
`,
);

const envFile = positionals[0] ? join(process.cwd(), positionals[0]) : join(repoRoot, ".env");
const env = loadEnv(envFile, { quiet: true });
const timeoutMs = Number(flags.timeout ?? 30000);
const lang = String(flags.lang ?? "fr") === "en" ? "en" : "fr";
const model = String(flags.model ?? "multilingual");

let baseUrl = String(flags.url ?? env.LAYA_BASE_URL ?? "http://localhost:8000").trim().replace(/\/+$/, "");
if (!flags.url && /^https?:\/\/laya(:\d+)?$/.test(baseUrl)) {
  // The compose-network name does not resolve from the host.
  baseUrl = baseUrl.replace("//laya", "//localhost");
  info(`LAYA_BASE_URL uses the compose service name; checking ${baseUrl} from the host`);
}

let apiKey = (env.LAYA_API_KEY ?? "").trim();
if (!apiKey && env.LAYA_API_KEY_FILE) {
  try {
    apiKey = readFileSync(env.LAYA_API_KEY_FILE, "utf8").trim();
  } catch (e) {
    fail(`LAYA_API_KEY_FILE cannot be read (${e.code ?? e.message})`);
    process.exit(1);
  }
}

let failed = false;

/* -- 1. /health ------------------------------------------------------------ */
step(`GET ${baseUrl}/health`);
const health = await request(`${baseUrl}/health`, { timeoutMs: Math.min(timeoutMs, 10000) });
if (!health.ok || !health.json) {
  fail(`GET /health -> ${health.status || "no response"} ${health.error ?? ""}`);
  info("Is the engine running? docker compose --profile laya up   |   kubectl -n oao get pods -l app.kubernetes.io/component=laya");
  process.exit(1);
}
const loaded = Array.isArray(health.json.loaded) ? health.json.loaded : [];
ok(`status=${health.json.status} device=${health.json.device ?? "?"} loaded=[${loaded.join(", ") || "none yet"}]`);
if (!loaded.length) warn("no checkpoint loaded yet: LAYA_PRELOAD=0, or the first request will pay the load");
else if (!loaded.includes(model)) warn(`checkpoint "${model}" is not loaded (loaded: ${loaded.join(", ")})`);

/* -- 2. /v1/systemone ------------------------------------------------------ */
async function orchestratorQuestions() {
  const dist = join(repoRoot, "apps", "orchestrator", "dist", "domain", "decisions");
  if (!existsSync(join(dist, "question-builder.js"))) return null;
  try {
    const qb = await import(pathToFileURL(join(dist, "question-builder.js")).href);
    const tx = await import(pathToFileURL(join(dist, "taxonomy.js")).href);
    const file = (env.LAYA_TAXONOMY_FILE ?? "").trim() || undefined;
    const taxonomy = tx.loadTaxonomy(file && existsSync(file) ? file : undefined);
    return { questions: qb.buildPrimaryQuestions(taxonomy.taxonomy, lang), source: `orchestrator questions, taxonomy ${taxonomy.taxonomy.version} (${taxonomy.example ? "bundled example" : taxonomy.source})` };
  } catch (e) {
    warn(`could not load the orchestrator's question builder (${e.message}) — using a minimal question`);
    return null;
  }
}

const fallbackQuestions = {
  urgency: {
    type: "choice",
    instructions: lang === "fr" ? "Détermine le niveau d'urgence du message." : "Determine how urgent the message is.",
    criteria: lang === "fr"
      ? { low: "aucune échéance ni impact", normal: "à traiter dans les jours qui viennent", high: "à traiter aujourd'hui", critical: "incident ou échéance immédiate" }
      : { low: "no deadline or impact", normal: "to handle in the coming days", high: "to handle today", critical: "incident or immediate deadline" },
  },
};

const built = await orchestratorQuestions();
const questions = built?.questions ?? fallbackQuestions;
const state = {
  language: lang,
  subject: lang === "fr" ? "Import NAV bloqué – fonds Alpha" : "NAV import blocked – Alpha fund",
  senderType: "internal",
  recipientCount: 1,
  externalRecipients: false,
  hasAttachments: false,
  signals: { triage: "conversation", phishing: "clean", urgencyMarkers: true, deadlineMentioned: true, requestMarkers: true, questionAsked: true, missingDocument: false, confidentialMarkers: false },
  body: lang === "fr"
    ? "Bonjour, l'import du fichier de positions NAV est bloqué depuis ce matin et la valorisation doit partir avant 16h. Pouvez-vous relancer le traitement et me confirmer ?"
    : "Hello, the NAV positions import has been blocked since this morning and the valuation must go out before 4pm. Can you restart the job and confirm?",
};

step(`POST ${baseUrl}/v1/systemone (model=${model}, ${Object.keys(questions).length} question(s), ${built ? built.source : "minimal question"})`);
const started = Date.now();
const res = await request(`${baseUrl}/v1/systemone`, {
  method: "POST",
  headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  body: { state, questions, model },
  timeoutMs,
});
const ms = Date.now() - started;
if (res.status === 401) {
  fail(`HTTP 401 — ${apiKey ? "the engine rejected LAYA_API_KEY" : "the engine requires a key: set LAYA_API_KEY (or LAYA_API_KEY_FILE)"}`);
  process.exit(1);
}
if (res.status === 422) {
  fail("HTTP 422 — the engine could not run the model: checkpoint missing from its cache (HF_HUB_OFFLINE=1 with an empty /models), or a load error. See docs/LAYA.md §weights.");
  process.exit(1);
}
if (!res.ok || !res.json) {
  fail(`POST /v1/systemone -> ${res.status || "no response"} ${res.error ?? ""}`);
  process.exit(1);
}

const answers = res.json.answers ?? {};
for (const [id, q] of Object.entries(questions)) {
  const a = answers[id];
  if (!a || a.type !== "choice" || !(a.choice in (q.criteria ?? {}))) {
    fail(`${id}: missing or unusable answer (${JSON.stringify(a)?.slice(0, 120)})`);
    failed = true;
    continue;
  }
  const sum = Object.values(a.probabilities ?? {}).reduce((s, p) => s + Number(p), 0);
  const conf = typeof a.confidence === "number" ? a.confidence.toFixed(2) : "none";
  const shape = Math.abs(sum - 1) <= 0.05 ? "" : `  (probabilities sum to ${sum.toFixed(3)}!)`;
  if (shape) failed = true;
  ok(`${id.padEnd(15)} → ${String(a.choice).padEnd(14)} confidence ${conf}${shape}`);
}
info(`answered by ${res.json.routing?.model ?? res.json.model ?? "?"} in ${ms} ms (tokens in: ${res.json.usage?.input_tokens ?? "?"})`);
info("Confidence is the engine's certainty over the options, not a probability of being right: calibrate on your own annotated emails (docs/LAYA.md §calibration).");

if (failed) {
  fail("the engine answered, but not in the expected shape — see above");
  process.exit(1);
}
ok("Laya is usable by the orchestrator");

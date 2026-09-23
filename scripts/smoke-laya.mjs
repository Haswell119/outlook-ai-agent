#!/usr/bin/env node
/**
 * `npm run smoke:laya` — end-to-end smoke test of the structured-decision
 * engine integration, with NO model and NO network: a fake Laya server that
 * speaks the real wire protocol (POST /v1/systemone, GET /health), the real
 * orchestrator (apps/orchestrator/dist, in-memory database, mock LLM) and
 * synthetic emails. Safe for CI.
 *
 * It checks, in order:
 *   active mode   decisions reach the response (decisioning), the classification
 *                 comes from the engine, the folder is only *proposed*
 *                 (move_to_folder, requiresConfirmation, never executed);
 *                 hierarchical questions (area first, then folder); a second
 *                 identical analysis is served from the cache without calling
 *                 the engine; /health, /admin/system and /metrics expose the
 *                 engine; the engine going down degrades the answer (LLM
 *                 fallback) while /ready stays 200.
 *   shadow mode   the engine is consulted but the response carries no
 *                 decisioning and keeps the historic classification.
 *   privacy       no orchestrator log line contains the email body, the
 *                 subject, a sender address or the Laya API key; the state
 *                 sent to the engine carries no address and no raw body.
 *
 *   npm run smoke:laya
 *   npm run smoke:laya -- --laya-url http://localhost:8000 --laya-key "$LAYA_API_KEY"
 *
 * With --laya-url the fake server is not started and the checks that depend on
 * the fake's answers are relaxed (a real engine answers what it answers): use
 * it against `docker compose --profile laya up` (weights downloaded).
 *
 * Exit code 0 = all checks passed.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { fail, helpIfRequested, info, ok, parseArgs, repoRoot, request, run, step, warn, waitFor } from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), { booleans: ["help", "h", "keep-logs"] });

helpIfRequested(
  flags,
  `
Usage: npm run smoke:laya -- [options]

Starts the orchestrator from apps/orchestrator/dist (built if missing) twice —
DECISION_PROVIDER=laya in active then shadow mode — against a fake Laya server,
and verifies decisions, caching, fallback, probes, metrics and log hygiene.
No model is downloaded, no external service is contacted.

Options:
  --laya-url <url>   use a running Laya instead of the fake (e.g. http://localhost:8000)
  --laya-key <key>   its API key (default $LAYA_API_KEY)
  --timeout <ms>     per-request timeout (default 20000)
  --keep-logs        print the orchestrator logs at the end
  -h, --help         show this help
`,
);

const timeoutMs = Number(flags.timeout ?? 20000);
const realLaya = flags["laya-url"] ? String(flags["laya-url"]).replace(/\/+$/, "") : "";
const LAYA_KEY = realLaya ? String(flags["laya-key"] ?? process.env.LAYA_API_KEY ?? "") : "smoke-laya-key-5c1e9a";
const ADMIN_TOKEN = "smoke-laya-admin-token-0123456789";
const METRICS_TOKEN = "smoke-laya-metrics-token-01234567";
// Canaries: none of them may ever appear in a log line.
const CANARY = {
  body: "BODYCANARY-4d71",
  subject: "SUBJCANARY-9a02",
  sender: "claire.canary@custodian-partner.example",
  phone: "+41 22 555 01 99",
};

let failures = 0;
const check = (label, passed, detail) => {
  if (passed) ok(label);
  else {
    failures += 1;
    fail(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  if (detail && passed) info(detail);
  return passed;
};

/* -------------------------------------------------------------------------- */
/*  Fake Laya (wire-compatible with laya-serve 0.3.9)                          */
/* -------------------------------------------------------------------------- */

function startFakeLaya() {
  const state = { down: false, requests: [] };
  const server = createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.down) return send(503, { detail: "fake engine down" });
    if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok", loaded: ["english", "multilingual"], device: "cpu" });
    if (req.method !== "POST" || req.url !== "/v1/systemone") return send(404, { detail: "not found" });
    if (req.headers.authorization !== `Bearer ${LAYA_KEY}`) return send(401, { detail: "invalid or missing bearer token" });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { detail: "not json" });
      }
      if (!body || typeof body !== "object" || !("questions" in body)) return send(400, { detail: "request body must be an object with a 'questions' field" });
      state.requests.push(body);
      const text = JSON.stringify(body.state ?? {}).toLowerCase();
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        const keys = Object.keys(q.criteria ?? {});
        let choice = keys[0];
        if (id === "urgency") choice = text.includes("urgent") ? "high" : "normal";
        else if (id === "replyExpected" || id === "actionRequired") choice = "required";
        else if (id === "businessArea") choice = text.includes("nav") && keys.includes("operations") ? "operations" : keys.includes("other") ? "other" : keys[0];
        else if (id === "folder") choice = keys.includes("nav") ? "nav" : keys[0];
        const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : Number((0.1 / Math.max(1, keys.length - 1)).toFixed(4))]));
        answers[id] = { type: "choice", choice, probabilities, confidence: 0.91, action: { act_probability: 0.5 } };
      }
      const model = body.model ?? "multilingual";
      send(200, { model, answers, usage: { input_tokens: 180, output_tokens: 0 }, routing: { model, reason: body.model ? "explicit" : "auto" } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator child process                                                */
/* -------------------------------------------------------------------------- */

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startOrchestrator(extraEnv) {
  const port = await freePort();
  const logs = [];
  const child = spawn(process.execPath, [join(repoRoot, "apps", "orchestrator", "dist", "server.js")], {
    cwd: join(repoRoot, "apps", "orchestrator"),
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: "memory",
      LLM_PROVIDER: "mock",
      AUTH_MODE: "dev",
      GRAPH_ENABLED: "false",
      LOG_LEVEL: "debug",
      LOG_FORMAT: "json",
      ADMIN_API_TOKEN: ADMIN_TOKEN,
      METRICS_TOKEN,
      INTERNAL_DOMAINS: "northbridge.example",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => logs.push(...String(d).split("\n").filter(Boolean)));
  child.stderr.on("data", (d) => logs.push(...String(d).split("\n").filter(Boolean)));
  const base = `http://127.0.0.1:${port}`;
  const ready = await waitFor(async () => (await request(`${base}/api/v1/ready`, { timeoutMs: 2000 })).ok, { timeoutMs: 30000, intervalMs: 300, label: "orchestrator /ready" });
  if (!ready) {
    fail(`orchestrator did not become ready:\n${logs.slice(-20).join("\n")}`);
    child.kill();
    process.exit(1);
  }
  const stop = () => new Promise((resolve) => (child.exitCode !== null ? resolve() : (child.once("exit", resolve), child.kill("SIGTERM"))));
  return { base, logs, stop };
}

/* -------------------------------------------------------------------------- */
/*  Synthetic emails                                                          */
/* -------------------------------------------------------------------------- */

const email = (id, subject, body) => ({
  id,
  conversationId: `conv-${id}`,
  subject: `${subject} ${CANARY.subject}`,
  from: { name: "Claire Canary", address: CANARY.sender },
  to: [{ name: "Ops Desk", address: "ops@northbridge.example" }],
  cc: [],
  bcc: [],
  receivedAt: new Date(Date.now() - 3_600_000).toISOString(),
  body: `${body}\n\nCordialement,\nClaire — ${CANARY.phone}\n${CANARY.body}`,
  attachments: [],
  categories: [],
});

const NAV = () =>
  email(
    "smoke-laya-nav-1",
    "URGENT – import NAV bloqué",
    "Bonjour,\n\nL'import du fichier de positions NAV du fonds Alpha est bloqué depuis ce matin : la valorisation ne peut pas être publiée. C'est urgent. Pouvez-vous relancer le traitement et me confirmer quand c'est corrigé ?",
  );

const headers = { "x-user-email": "smoke-laya@northbridge.example", "x-user-name": "Smoke Laya" };
const analyze = (base, e) => request(`${base}/api/v1/analyze/email`, { method: "POST", headers, body: { email: e, includeThread: false }, timeoutMs });

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

if (!existsSync(join(repoRoot, "apps", "orchestrator", "dist", "server.js")) || !existsSync(join(repoRoot, "packages", "shared", "dist", "index.js"))) {
  warn("orchestrator not built yet — building @oao/shared and @oao/orchestrator");
  run("npm", ["run", "build", "-w", "@oao/shared"], { quiet: true });
  run("npm", ["run", "build", "-w", "@oao/orchestrator"], { quiet: true });
}
const S = await import(pathToFileURL(join(repoRoot, "packages", "shared", "dist", "index.js")).href);

const fake = realLaya ? null : await startFakeLaya();
const layaUrl = realLaya || fake.url;
step(`Laya endpoint: ${realLaya ? `${realLaya} (real engine)` : `${layaUrl} (fake, no model)`}`);

const layaEnv = { DECISION_PROVIDER: "laya", LAYA_BASE_URL: layaUrl, LAYA_API_KEY: LAYA_KEY, LAYA_TIMEOUT_MS: "4000", LAYA_CIRCUIT_FAILURE_THRESHOLD: "2", LAYA_CIRCUIT_COOLDOWN_MS: "60000" };
const allLogs = [];

/* -- active mode ------------------------------------------------------------ */
step("Active mode (LAYA_MODE=active)");
const active = await startOrchestrator({ ...layaEnv, LAYA_MODE: "active" });
try {
  const first = await analyze(active.base, NAV());
  const parsed = S.EmailAnalysisSchema.safeParse(first.json);
  check("POST /analyze/email → 200 and valid contract", first.status === 200 && parsed.success, parsed.success ? undefined : `HTTP ${first.status} ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`);
  const a = parsed.success ? parsed.data : {};
  const d = a.decisioning;
  check("decisioning present, mode active", d?.mode === "active", d ? `source=${d.source} model=${d.model ?? "-"} taxonomy=${d.taxonomyVersion ?? "-"}` : "absent");
  if (!realLaya) {
    check("engine decisions used (source laya, not degraded)", d?.source === "laya" && d?.degraded === false, JSON.stringify({ source: d?.source, degraded: d?.degraded, reason: d?.fallbackReason }));
    check("urgency / area / folder / reply decided by the engine", d?.urgency?.level === "high" && d?.businessArea?.id === "operations" && d?.suggestedFolder?.id === "nav" && d?.replyExpected?.value === true, JSON.stringify({ urgency: d?.urgency, area: d?.businessArea?.id, folder: d?.suggestedFolder?.id }));
    check("classification comes from the engine's folder", a.classification?.category === d?.suggestedFolder?.displayName, a.classification?.category);
    const move = (a.suggestedActions ?? []).find((s) => s.type === "move_to_folder");
    check("folder only proposed: move_to_folder requires confirmation, not selected by default", !!move && move.parameters?.requiresConfirmation === true && move.parameters?.selectedByDefault === false, move ? `${move.title}` : "no move_to_folder suggestion");
    const qids = fake.state.requests.map((r) => Object.keys(r.questions).sort().join(","));
    check("hierarchical questions: primary set, then the folder within the area", qids[0] === "actionRequired,businessArea,replyExpected,urgency" && qids[1] === "folder", qids.join(" | "));
    const sent = JSON.stringify(fake.state.requests);
    check("state sent to the engine: no sender address, no signature phone, no canary body", !sent.includes(CANARY.sender) && !sent.includes(CANARY.phone) && !sent.includes("ops@northbridge.example"), `${fake.state.requests.length} request(s), ${sent.length} bytes`);
  }

  const callsBefore = fake?.state.requests.length ?? 0;
  const again = await analyze(active.base, NAV());
  check("same email again → served from cache", again.status === 200 && ["cache", "precomputed"].includes(again.json?.source), `source=${again.json?.source}`);
  if (fake) check("…without calling the engine again", fake.state.requests.length === callsBefore, `${fake.state.requests.length - callsBefore} extra call(s)`);

  const health = S.HealthSchema.safeParse((await request(`${active.base}/api/v1/health`, { timeoutMs })).json);
  check("/health has a laya check", health.success && !!health.data.checks.laya, health.success ? JSON.stringify(health.data.checks.laya) : "invalid");
  const sys = await request(`${active.base}/api/v1/admin/system`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, timeoutMs });
  const status = S.SystemStatusSchema.safeParse(sys.json);
  check("/admin/system reports the engine (no URL, no key)", status.success && status.data.decisioning?.provider === "laya" && !sys.body.includes(layaUrl) && !sys.body.includes(LAYA_KEY), status.success ? `state=${status.data.decisioning?.state} circuit=${status.data.decisioning?.circuit} decisions=${status.data.decisioning?.stats.decisions}` : `HTTP ${sys.status}`);
  const metrics = await request(`${active.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` }, timeoutMs });
  check("/metrics exposes oao_laya_* families", /oao_laya_requests_total\{outcome="ok"\}/.test(metrics.body) && metrics.body.includes("oao_laya_model_calls_saved_total"), `HTTP ${metrics.status}`);

  if (fake) {
    fake.state.down = true;
    const down = await analyze(active.base, email("smoke-laya-down-1", "Question sur le rapport", "Bonjour, pouvez-vous m'envoyer le rapport de réconciliation du fonds Beta ?"));
    const dd = down.json?.decisioning;
    check("engine down → analysis still answered, decisions fall back to the LLM", down.status === 200 && dd?.degraded === true && dd?.source === "llm_fallback", JSON.stringify({ status: down.status, source: dd?.source, reason: dd?.fallbackReason }));
    const ready = await request(`${active.base}/api/v1/ready`, { timeoutMs });
    check("/ready stays 200 while the engine is down", ready.status === 200);
    fake.state.down = false;
  }
} finally {
  await active.stop();
  allLogs.push(...active.logs);
}

/* -- shadow mode ------------------------------------------------------------ */
step("Shadow mode (LAYA_MODE=shadow)");
const shadow = await startOrchestrator({ ...layaEnv, LAYA_MODE: "shadow" });
try {
  const before = fake?.state.requests.length ?? 0;
  const res = await analyze(shadow.base, email("smoke-laya-shadow-1", "URGENT – NAV du fonds Gamma", "L'import NAV du fonds Gamma a échoué, merci de vérifier rapidement ?"));
  const parsed = S.EmailAnalysisSchema.safeParse(res.json);
  check("shadow: 200, valid contract, no decisioning in the response", res.status === 200 && parsed.success && parsed.data.decisioning === undefined, parsed.success ? `classification=${parsed.data.classification?.category ?? "-"}` : `HTTP ${res.status}`);
  check("shadow: no move_to_folder suggestion from the engine", !(parsed.data?.suggestedActions ?? []).some((s) => s.parameters?.rule === "laya_folder_suggestion"));
  if (fake) check("shadow: the engine was still consulted", fake.state.requests.length > before, `${fake.state.requests.length - before} call(s)`);
} finally {
  await shadow.stop();
  allLogs.push(...shadow.logs);
}

/* -- log hygiene ------------------------------------------------------------ */
step("Log hygiene");
const dump = allLogs.join("\n");
const leaks = [
  ["email body", CANARY.body],
  ["subject", CANARY.subject],
  ["sender address", CANARY.sender],
  ["signature phone", CANARY.phone],
  ["Laya API key", LAYA_KEY],
].filter(([, needle]) => needle && dump.includes(needle));
check(`${allLogs.length} orchestrator log lines: no body, subject, address or key`, leaks.length === 0, leaks.length ? leaks.map(([what]) => what).join(", ") : undefined);
if (flags["keep-logs"]) console.log(dump);

fake?.server.close();
if (failures) {
  fail(`${failures} check(s) failed`);
  process.exit(1);
}
ok("Laya integration smoke test passed");

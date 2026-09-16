#!/usr/bin/env node
/**
 * `pnpm smoke` — end-to-end smoke test against a running orchestrator.
 *
 * Two modes:
 *
 *  - **quick** (default): probes, metrics, feature flags and one call per major
 *    feature. A few seconds, no state left behind beyond the audit trail.
 *  - **full** (`--full`): a complete functional verification of every feature,
 *    in the order a real user exercises them — index a small realistic mailbox,
 *    search it, ask a question about it, analyse, synthesise, draft, propose and
 *    approve actions, run the compliance and phishing checks, escalate, teach
 *    and approve an automation, generate the daily brief, then read the audit
 *    trail back. Every response is validated against the shared zod contract.
 *
 *   pnpm smoke
 *   pnpm smoke --full
 *   pnpm smoke --full --reindex --lang fr
 *   pnpm smoke --full --url https://api.oao.northbridge.example --token "$JWT"
 *
 * Exit code 0 = all checks passed.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  fail,
  helpIfRequested,
  info,
  loadEnv,
  ok,
  parseArgs,
  preview,
  repoRoot,
  request,
  run,
  step,
  style,
  warn,
  waitFor,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), { booleans: ["help", "h", "quiet", "full", "reindex", "json"] });

helpIfRequested(
  flags,
  `
Usage: pnpm smoke [options]

Quick mode (default) — is the deployment alive and wired?
  GET  /api/v1/live            liveness probe (Kubernetes)
  GET  /api/v1/ready           readiness probe (dependencies, vector dimensions)
  GET  /api/v1/health          aggregated health, per-dependency detail
  GET  /metrics                Prometheus exposition (needs --metrics-token)
  GET  /api/v1/config/features feature flags
  POST /api/v1/analyze/email   summary, decisions, risks
  POST /api/v1/compliance/check  Compliance Guardian verdict
  POST /api/v1/chat            conversational search

Full mode (--full) — does every feature actually work, end to end?
  Indexes 5 realistic FR/EN emails (a 3-message project thread, a newsletter and
  an external invoice carrying an IBAN) into the caller's mailbox, then checks:
    index → search → chat (must cite a source)
    analyze (llm|cache|precomputed) → analyze again (cache) → newsletter
      (heuristic + newsletter triage) → newsletter with force (llm)
    thread synthesis → draft reply (accept + decline)
    propose actions → approve one → report the client-side result
    compliance check on an external draft with an IBAN (>= 2 issues)
    phishing check on a lookalike sender → compliance escalation
    automations: observe 3 identical sequences → detect → simulate → approve
    daily brief (POST then GET)
    audit list + stats + CSV export + /admin/system   (needs --admin-token)
    /metrics (needs --metrics-token), then /ready and /live again
  Every response is validated with the zod schemas of @oao/shared, so a contract
  drift fails the run even when the HTTP status is 200.

Options:
  --full                  run the complete functional verification
  --reindex               (full) index the sample mailbox again and require
                          mode=hybrid when embeddings are enabled — use it after
                          a dimension change discarded the stored embeddings
  --lang <fr|en>          language requested for the AI answers (default en)
  --url <url>             orchestrator base URL (default $ORCHESTRATOR_URL or
                          http://localhost:8080)
  --token <jwt>           Authorization: Bearer <jwt>  (AUTH_MODE=aad)
  --admin-token <tok>     ADMIN_API_TOKEN, for the admin-only checks
                          (default $ADMIN_API_TOKEN)
  --metrics-token <tok>   bearer token for /metrics (default $METRICS_TOKEN)
  --user <email>          x-user-email header used in AUTH_MODE=dev
  --wait <seconds>        wait for /api/v1/ready before testing (default 0)
  --timeout <ms>          per-request timeout (default 30000)
  --json                  print a machine-readable report on stdout
  --quiet                 do not print the per-step detail line
  -h, --help              show this help
`,
);

const env = loadEnv(undefined, { quiet: true });
const baseUrl = String(flags.url ?? env.ORCHESTRATOR_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const api = `${baseUrl}/api/v1`;
const token = flags.token ?? env.SMOKE_TOKEN ?? "";
const metricsToken = flags["metrics-token"] ?? env.METRICS_TOKEN ?? "";
const adminToken = flags["admin-token"] ?? env.ADMIN_API_TOKEN ?? "";
const user = String(flags.user ?? env.SMOKE_TEST_USER_EMAIL ?? "smoke-test@northbridge.example");
const timeoutMs = Number(flags.timeout ?? 30000);
const waitSeconds = Number(flags.wait ?? 0);
const lang = String(flags.lang ?? "en").toLowerCase() === "fr" ? "fr" : "en";
const jsonMode = Boolean(flags.json);

const authHeaders = token ? { authorization: `Bearer ${token}` } : { "x-user-email": user, "x-user-name": "Smoke Test" };
/** Admin identity: `ADMIN_API_TOKEN` works in both AUTH_MODE=dev and aad. */
const adminHeaders = adminToken ? { authorization: `Bearer ${adminToken}` } : undefined;

/* -------------------------------------------------------------------------- */
/*  Reporting                                                                 */
/* -------------------------------------------------------------------------- */

/** In --json mode the human log goes to stderr so stdout stays parseable. */
const say = {
  step: (m) => (jsonMode ? console.error(`==> ${m}`) : step(m)),
  ok: (m) => (jsonMode ? console.error(`OK   ${m}`) : ok(m)),
  warn: (m) => (jsonMode ? console.error(`WARN ${m}`) : warn(m)),
  fail: (m) => (jsonMode ? console.error(`FAIL ${m}`) : fail(m)),
  info: (m) => (jsonMode ? console.error(`     ${m}`) : info(m)),
};

/** One row of the final table. */
const results = [];
let failures = 0;

const check = (label, passed, detail) => {
  results.push({ step: label, status: passed ? "pass" : "fail", detail: detail ?? "" });
  if (passed) {
    say.ok(label);
    if (detail && !flags.quiet) say.info(detail);
  } else {
    failures += 1;
    say.fail(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  return passed;
};

const skip = (label, why) => {
  results.push({ step: label, status: "skip", detail: why });
  say.warn(`${label} — skipped: ${why}`);
};

/**
 * Run one functional step: `fn` returns the "key facts" string, or throws
 * `Expectation` to fail the step with an explanation.
 */
async function measure(label, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - startedAt;
    results.push({ step: label, status: "pass", detail: detail ?? "", ms });
    say.ok(`${label}  ${style.dim(`${ms} ms`)}`);
    if (detail && !flags.quiet) say.info(detail);
    return true;
  } catch (e) {
    const ms = Date.now() - startedAt;
    failures += 1;
    const detail = e instanceof Expectation ? e.message : `${e.name}: ${e.message}`;
    results.push({ step: label, status: "fail", detail, ms });
    say.fail(`${label} — ${detail}`);
    return false;
  }
}

/** A failed expectation inside a step (not a bug in the script). */
class Expectation extends Error {
  constructor(message) {
    super(message);
    this.name = "Expectation";
  }
}
const expect = (condition, message) => {
  if (!condition) throw new Expectation(message);
};

/* -------------------------------------------------------------------------- */
/*  HTTP + contract validation                                                */
/* -------------------------------------------------------------------------- */

const call = (path, { method = "GET", body, headers = authHeaders, raw = false } = {}) =>
  request(`${path.startsWith("http") ? "" : api}${path}`, { method, headers, body, timeoutMs }).then((r) => (raw ? r : r));

/**
 * Assert the HTTP status and validate the body against a shared zod schema.
 * A contract drift (missing field, wrong enum) fails the step even on a 200.
 */
function decode(res, schema, { expectStatus = 200, what = "response" } = {}) {
  const statuses = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
  expect(statuses.includes(res.status), `expected HTTP ${statuses.join("/")} for ${what}, got ${res.status || "no response"} ${preview(res.body ?? "", 200)}${res.error ? ` (${res.error})` : ""}`);
  expect(res.json !== undefined, `${what}: response is not JSON — ${preview(res.body ?? "", 120)}`);
  if (!schema) return res.json;
  const parsed = schema.safeParse(res.json);
  expect(parsed.success, `${what}: does not match the @oao/shared contract — ${parsed.error?.issues?.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/*  Fixtures — a small but realistic FR/EN mailbox                            */
/* -------------------------------------------------------------------------- */

const RUN = `smoke-${Date.now().toString(36)}`;
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const PARTNER_DOMAIN = "contoso-partner.example";

const threadId = `${RUN}-conv-atlas`;

/** [1/5] Kick-off of the project thread (EN, with a deck attached). */
const atlas1 = {
  id: `${RUN}-atlas-1`,
  conversationId: threadId,
  internetMessageId: `<${RUN}-atlas-1@${PARTNER_DOMAIN}>`,
  subject: "Project Atlas — kickoff, scope and budget",
  from: { name: "John Carter", address: `pm@${PARTNER_DOMAIN}` },
  to: [{ name: "Smoke Test", address: user }],
  receivedAt: iso(300),
  body:
    "Hello,\n\nFollowing our call, here is the kickoff deck for project Atlas. The scope covers the migration " +
    "of the reporting platform and the first phase is planned for October. The initial budget is EUR 42,000.\n\n" +
    "Could you please review the deck and confirm the scope on your side?\n\nBest regards,\nJohn Carter",
  attachments: [{ name: "Atlas-Kickoff-Deck.pdf", contentType: "application/pdf", size: 240_512 }],
  folder: "Inbox",
};

/** [2/5] French reply in the same thread (decision taken). */
const atlas2 = {
  id: `${RUN}-atlas-2`,
  conversationId: threadId,
  internetMessageId: `<${RUN}-atlas-2@${PARTNER_DOMAIN}>`,
  subject: "RE: Project Atlas — kickoff, scope and budget",
  from: { name: "Marie Dupont", address: `marie.dupont@${PARTNER_DOMAIN}` },
  to: [{ name: "Smoke Test", address: user }],
  receivedAt: iso(180),
  body:
    "Bonjour,\n\nNous avons validé le périmètre du projet Atlas en comité ce matin : la migration de la plateforme " +
    "de reporting est approuvée pour la phase 1. Il reste à confirmer le budget révisé avec la direction financière.\n\n" +
    "Cordialement,\nMarie Dupont",
  attachments: [],
  folder: "Inbox",
};

/** [3/5] The follow-up: an explicit request, a deadline and an attachment. */
const atlas3 = {
  id: `${RUN}-atlas-3`,
  conversationId: threadId,
  internetMessageId: `<${RUN}-atlas-3@${PARTNER_DOMAIN}>`,
  subject: "RE: Project Atlas — kickoff, scope and budget",
  from: { name: "John Carter", address: `pm@${PARTNER_DOMAIN}` },
  to: [{ name: "Smoke Test", address: user }],
  receivedAt: iso(90),
  body:
    "Hello,\n\nThank you for the confirmation of the scope. Attached is the revised budget for project Atlas: " +
    "EUR 48,000 instead of EUR 42,000, because of the additional data migration effort.\n\n" +
    "Could you please confirm the revised budget of EUR 48,000 before Friday? Without your confirmation we cannot " +
    "book the October slot for the migration, and the signed statement of work is still outstanding on our side.\n\n" +
    "Best regards,\nJohn Carter",
  attachments: [{ name: "Atlas-Budget-v2.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 51_204 }],
  folder: "Inbox",
};

/** [4/5] A newsletter: must be triaged without any model call. */
const newsletter = {
  id: `${RUN}-newsletter`,
  conversationId: `${RUN}-conv-news`,
  subject: "FinTech Weekly — issue 214: payment rails, AI agents and open banking",
  from: { name: "FinTech Weekly", address: "newsletter@fintech-weekly.example" },
  to: [{ name: "Smoke Test", address: user }],
  receivedAt: iso(60),
  body:
    "FinTech Weekly, issue 214\n\nThis week: instant payment rails in Europe, what AI agents change for back offices, " +
    "and the next open-banking deadlines.\n\nRead the full issue on our website.\n\n" +
    "You are receiving this email because you subscribed to FinTech Weekly. Unsubscribe | Manage your preferences | View in browser",
  attachments: [],
  folder: "Inbox",
};

/** [5/5] An external invoice with an IBAN — the compliance-sensitive one. */
const invoice = {
  id: `${RUN}-invoice`,
  conversationId: `${RUN}-conv-invoice`,
  subject: "Facture INV-2098 — coordonnées bancaires mises à jour",
  from: { name: "GlobalPay Treasury", address: "treasury@globalpay-invoices.example" },
  to: [{ name: "Smoke Test", address: user }],
  receivedAt: iso(45),
  body:
    "Bonjour,\n\nVeuillez trouver ci-joint la facture INV-2098 d'un montant de CHF 12'480.\n\n" +
    "Merci de noter que nos coordonnées bancaires ont changé : le nouvel IBAN est CH93 0076 2011 6238 5295 7. " +
    "Merci d'utiliser ce compte pour tout paiement à venir.\n\nCordialement,\nGlobalPay Treasury",
  attachments: [{ name: "INV-2098.pdf", contentType: "application/pdf", size: 88_140 }],
  folder: "Inbox",
};

const mailbox = [atlas1, atlas2, atlas3, newsletter, invoice];

/** An external draft that must trip at least two compliance rules. */
const sensitiveDraft = {
  to: [{ name: "External Client", address: "client@clientco.example" }],
  cc: [],
  bcc: [],
  subject: "Confidential — Q2 performance report and payment instructions",
  body:
    "Hi,\n\nPlease find attached the confidential Q2 performance report for the client mandate.\n\n" +
    "Payment can be made to IBAN CH93 0076 2011 6238 5295 7 (account 123456789).\n\nKind regards",
  attachments: [{ name: "Client A - Q2 Performance Report (Confidential).pdf", contentType: "application/pdf" }],
};

/** A lookalike sender: `northbrigde` instead of `northbridge`. */
const phishingEmail = {
  id: `${RUN}-phish`,
  subject: "Action required: verify your account within 24 hours",
  from: { name: "Northbridge IT Support", address: "it-support@northbrigde.example" },
  to: [{ name: "Smoke Test", address: user }],
  receivedAt: iso(15),
  body:
    "Dear user,\n\nOur records show that your mailbox password expires today. Confirm your identity immediately to " +
    "avoid your account being suspended: https://northbrigde-example.verify-now.example/login\n\n" +
    "Please sign in with your credentials to update your details.\n\nIT Support",
  attachments: [],
};

/**
 * Three identical routines on the same sender domain — the automation to detect.
 *
 * The subjects share exactly one long token ("atlas"), which is what the
 * detector turns into the `subjectContains` trigger condition, so the indexed
 * Atlas emails with an attachment are a meaningful simulation sample.
 */
const ROUTINE_SUBJECTS = ["Atlas status 2026-09-01", "Atlas update 2026-09-08", "Atlas recap 2026-09-15"];
const automationEvents = [0, 1, 2].flatMap((n) =>
  ["save_attachment", "categorize", "create_reminder"].map((type, i) => ({
    type,
    occurredAt: iso(600 - n * 120 - (2 - i)),
    email: {
      id: `${RUN}-routine-${n}`,
      conversationId: `${RUN}-conv-routine-${n}`,
      fromAddress: `pm@${PARTNER_DOMAIN}`,
      fromDomain: PARTNER_DOMAIN,
      subject: ROUTINE_SUBJECTS[n],
      hasAttachments: true,
      attachmentTypes: ["application/pdf"],
    },
    parameters: type === "categorize" ? { category: "Project Atlas" } : type === "create_reminder" ? { title: "Review Atlas status" } : { folder: "Atlas/Reports" },
  })),
);

/* -------------------------------------------------------------------------- */
/*  Quick mode                                                                */
/* -------------------------------------------------------------------------- */

async function runQuick() {
  const live = await call("/live");
  check("GET /api/v1/live", live.ok, live.ok ? undefined : `HTTP ${live.status} ${live.error ?? ""}`);

  const ready = await call("/ready");
  check("GET /api/v1/ready", ready.ok, ready.ok ? preview(ready.body, 160) : `HTTP ${ready.status} ${preview(ready.body)} ${ready.error ?? ""}`);

  const health = await call("/health");
  check("GET /api/v1/health", health.ok, preview(health.body, 200));
  if (health.json?.status === "degraded") say.warn("health is 'degraded' — check the per-dependency detail above (LLM / Graph / DB / vectors)");

  const metrics = await request(`${baseUrl}/metrics`, { headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : {}, timeoutMs });
  if (metrics.status === 401 || metrics.status === 403) say.warn("/metrics requires a token — pass --metrics-token (this is the expected production behaviour)");
  else if (metrics.status === 404) say.warn("/metrics not exposed (METRICS_ENABLED=false?)");
  else check("GET /metrics", metrics.ok && metrics.body.includes("# HELP"), metrics.ok ? `${metrics.body.split("\n").length} lines` : `HTTP ${metrics.status}`);

  const features = await call("/config/features");
  check("GET /api/v1/config/features", features.ok, preview(features.body, 200));

  const analyze = await call("/analyze/email", { method: "POST", body: { email: atlas3, language: lang } });
  check("POST /api/v1/analyze/email", analyze.ok, analyze.ok ? preview(analyze.body) : `HTTP ${analyze.status} ${preview(analyze.body)}`);

  const compliance = await call("/compliance/check", { method: "POST", body: { draft: sensitiveDraft, language: lang } });
  check("POST /api/v1/compliance/check", compliance.ok, compliance.ok ? preview(compliance.body) : `HTTP ${compliance.status} ${preview(compliance.body)}`);

  const chat = await call("/chat", { method: "POST", body: { message: "Find the email where the revised budget was communicated.", language: lang } });
  check("POST /api/v1/chat", chat.ok, chat.ok ? preview(chat.body) : `HTTP ${chat.status} ${preview(chat.body)}`);
}

/* -------------------------------------------------------------------------- */
/*  Full mode                                                                 */
/* -------------------------------------------------------------------------- */

/** Load the shared contract (built dist), building it once if necessary. */
async function loadContract() {
  const dist = pathToFileURL(join(repoRoot, "packages", "shared", "dist", "index.js")).href;
  try {
    return await import(dist);
  } catch {
    say.warn("@oao/shared is not built yet — building it now (pnpm --filter @oao/shared build)");
    run("pnpm", ["--filter", "@oao/shared", "build"], { quiet: true });
    return import(dist);
  }
}

async function runFull() {
  const S = await loadContract();
  const facts = {};

  /* ----------------------------- 1. probes ----------------------------- */
  await measure("probes: /live, /ready, /health", async () => {
    const live = await call("/live");
    expect(live.status === 200, `/live returned HTTP ${live.status}`);
    const ready = await call("/ready");
    expect(ready.status === 200, `/ready returned HTTP ${ready.status}: ${preview(ready.body, 200)}`);
    const health = decode(await call("/health"), S.HealthSchema, { what: "/health" });
    facts.health = health.status;
    const down = Object.entries(health.checks).filter(([, c]) => c.status === "down");
    expect(!down.length, `/health reports a dependency down: ${down.map(([k, c]) => `${k} (${c.detail})`).join(", ")}`);
    return `health=${health.status}, ready=${preview(ready.json?.detail ?? "", 90)}`;
  });

  /* ---------------------------- 2. features ---------------------------- */
  await measure("GET /config/features", async () => {
    const f = decode(await call("/config/features"), S.FeatureFlagsSchema, { what: "/config/features" });
    facts.embeddingsEnabled = f.embeddingsEnabled;
    facts.llm = `${f.llmProvider}/${f.llmModel}`;
    return `llm=${f.llmProvider}/${f.llmModel}, embeddings=${f.embeddingsEnabled}${f.embeddingModel ? ` (${f.embeddingModel})` : ""}, graph=${f.graphEnabled}, v${f.version}`;
  });

  /* ---------------------------- 3. indexing ---------------------------- */
  await measure(`POST /index/emails (${mailbox.length} emails)`, async () => {
    let r = decode(await call("/index/emails", { method: "POST", body: { emails: mailbox } }), S.IndexEmailsResponseSchema, { what: "/index/emails" });
    if (flags.reindex) r = decode(await call("/index/emails", { method: "POST", body: { emails: mailbox } }), S.IndexEmailsResponseSchema, { what: "/index/emails (re-index)" });
    expect(r.indexed === mailbox.length, `indexed ${r.indexed}/${mailbox.length} emails (skipped ${r.skipped})`);
    facts.indexMode = r.mode;
    if (r.warning) say.warn(`indexing is degraded: ${r.warning}`);
    // A dimension mismatch or a missing pgvector is a *supported* degradation:
    // the run continues in lexical mode. With --reindex the caller is explicitly
    // verifying that embeddings came back, so hybrid becomes mandatory.
    if (flags.reindex && facts.embeddingsEnabled) expect(r.mode === "hybrid", `--reindex expected mode=hybrid but got "${r.mode}"${r.warning ? ` (${r.warning})` : ""}`);
    return `indexed=${r.indexed}, skipped=${r.skipped}, mode=${r.mode}${r.warning ? `, warning="${preview(r.warning, 120)}"` : ""}`;
  });

  /* ----------------------------- 4. search ----------------------------- */
  await measure("POST /search", async () => {
    const r = decode(await call("/search", { method: "POST", body: { query: "Atlas revised budget confirmation", limit: 10 } }), S.SearchResponseSchema, { what: "/search" });
    const ids = r.results.map((x) => x.emailId);
    expect(r.results.length > 0, "search returned no result for an indexed email");
    expect(ids.some((id) => id.startsWith(RUN)), `search did not return any of the emails just indexed (got ${ids.slice(0, 3).join(", ") || "nothing"})`);
    return `${r.results.length} results, mode=${r.mode}, top="${preview(r.results[0].subject, 60)}" (${r.results[0].relevance})`;
  });

  /* ------------------------------ 5. chat ------------------------------ */
  await measure("POST /chat (must cite a source)", async () => {
    const r = decode(
      await call("/chat", { method: "POST", body: { message: "What is the revised budget for project Atlas and by when must it be confirmed?", language: lang } }),
      S.ChatResponseSchema,
      { what: "/chat" },
    );
    expect(r.answer.trim().length > 0, "chat returned an empty answer");
    expect(r.sources.length >= 1, "chat cited no source (expected at least one from the indexed thread)");
    facts.chatSources = r.sources.length;
    return `${r.sources.length} source(s) cited, confidence=${r.confidence}, answer="${preview(r.answer, 90)}"`;
  });

  /* ---------------------------- 6. analyze ----------------------------- */
  let analysisAuditId;
  await measure("POST /analyze/email (follow-up)", async () => {
    const a = decode(await call("/analyze/email", { method: "POST", body: { email: atlas3, language: lang } }), S.EmailAnalysisSchema, { what: "/analyze/email" });
    expect(["llm", "cache", "precomputed"].includes(a.source ?? ""), `expected source llm|cache|precomputed, got "${a.source}"`);
    expect(a.summary.trim().length > 0, "the analysis summary is empty");
    expect(a.pendingTasks.length >= 1, "expected at least one pending task on a follow-up asking for a confirmation");
    analysisAuditId = a.auditId;
    return `source=${a.source}, tasks=${a.pendingTasks.length}, risks=${a.risks.length}, actions=${a.suggestedActions.length}, confidence=${a.confidence}`;
  });

  await measure("POST /analyze/email again (must hit the cache)", async () => {
    const a = decode(await call("/analyze/email", { method: "POST", body: { email: atlas3, language: lang } }), S.EmailAnalysisSchema, { what: "/analyze/email (2nd call)" });
    expect(a.source === "cache", `expected source=cache on the second identical call, got "${a.source}"`);
    return `source=${a.source}, model=${a.model ?? "-"}`;
  });

  await measure("POST /analyze/email (newsletter → heuristic triage)", async () => {
    const a = decode(await call("/analyze/email", { method: "POST", body: { email: newsletter, language: lang } }), S.EmailAnalysisSchema, { what: "/analyze/email (newsletter)" });
    expect(a.source === "heuristic", `expected source=heuristic for a newsletter (no model call), got "${a.source}"`);
    expect(a.triage?.kind === "newsletter", `expected triage.kind=newsletter, got "${a.triage?.kind}"`);
    return `source=${a.source}, triage=${a.triage?.kind} (${a.triage?.reason}), no model call`;
  });

  await measure("POST /analyze/email (newsletter, force → llm)", async () => {
    const a = decode(await call("/analyze/email", { method: "POST", body: { email: newsletter, language: lang, force: true } }), S.EmailAnalysisSchema, { what: "/analyze/email (force)" });
    expect(a.source === "llm", `expected source=llm when force=true, got "${a.source}"`);
    return `source=${a.source}, model=${a.model ?? "-"}, triage kept=${a.triage?.kind ?? "-"}`;
  });

  /* ------------------------ 7. thread synthesis ------------------------ */
  await measure("POST /analyze/thread", async () => {
    const t = decode(
      await call("/analyze/thread", { method: "POST", body: { thread: { conversationId: threadId, subject: atlas1.subject, messages: [atlas1, atlas2, atlas3] }, language: lang } }),
      S.ThreadSynthesisSchema,
      { what: "/analyze/thread" },
    );
    expect(t.executiveSummary.trim().length > 0, "the executive summary is empty");
    expect(t.sources.length >= 1, "the synthesis cites no source message");
    return `summary=${t.executiveSummary.length} chars, tasks=${t.openTasks.length}, deadlines=${t.deadlines.length}, missingDocs=${t.missingDocuments.length}, sources=${t.sources.length}`;
  });

  /* -------------------------- 8. draft reply --------------------------- */
  for (const intent of ["accept", "decline"]) {
    await measure(`POST /draft/reply (${intent})`, async () => {
      const d = decode(await call("/draft/reply", { method: "POST", body: { email: atlas3, intent, tone: "formal", language: lang } }), S.DraftReplySchema, { what: `/draft/reply (${intent})` });
      expect(d.body.trim().length > 20, `the ${intent} draft body is suspiciously short`);
      expect(d.language === lang, `draft language is "${d.language}", expected "${lang}"`);
      return `subject="${preview(d.subject, 50)}", ${d.body.length} chars, confidence=${d.confidence}`;
    });
  }

  /* ------------------------- 9. actions (HITL) ------------------------- */
  let proposalId;
  let approvedAction;
  await measure("POST /actions/propose", async () => {
    const p = decode(await call("/actions/propose", { method: "POST", body: { email: atlas3, analysisAuditId, language: lang } }), S.ActionProposalSchema, { what: "/actions/propose" });
    expect(p.actions.length >= 1, "no action proposed for a follow-up with an attachment and a deadline");
    expect(p.humanValidationRequired === true, "humanValidationRequired must always be true");
    proposalId = p.proposalId;
    approvedAction = p.actions.find((a) => a.selectedByDefault && !a.requiresComplianceApproval) ?? p.actions[0];
    return `${p.actions.length} actions (${p.actions.map((a) => a.type).slice(0, 4).join(", ")}), expires ${p.expiresAt}`;
  });

  let reportableActionId;
  await measure("POST /actions/approve", async () => {
    expect(proposalId && approvedAction, "no proposal to approve (the previous step failed)");
    const r = decode(
      await call("/actions/approve", { method: "POST", body: { proposalId, actionIds: [approvedAction.id], comment: "approved by pnpm smoke --full" } }),
      S.ApproveActionsResponseSchema,
      { what: "/actions/approve" },
    );
    expect(r.results.length === 1, `expected 1 result, got ${r.results.length}`);
    const res = r.results[0];
    expect(["pending_client", "executed"].includes(res.status), `expected status pending_client|executed, got "${res.status}" (${res.message ?? "no message"})`);
    if (res.status === "pending_client") reportableActionId = res.actionId;
    return `${res.type} → ${res.status}${res.clientInstruction ? ` (client: ${res.clientInstruction.operation})` : ""}`;
  });

  await measure("POST /actions/:id/result", async () => {
    expect(reportableActionId ?? approvedAction, "no approved action to report a result for");
    const id = reportableActionId ?? approvedAction.id;
    const r = decode(await call(`/actions/${encodeURIComponent(id)}/result`, { method: "POST", body: { status: "executed", message: "executed by pnpm smoke --full" } }), S.ActionResultSchema, { what: "/actions/:id/result" });
    expect(r.status === "executed", `expected the reported status to be stored as executed, got "${r.status}"`);
    return `${r.type} → ${r.status}, auditId=${r.auditId}`;
  });

  /* --------------------------- 10. compliance -------------------------- */
  let complianceIssues = [];
  await measure("POST /compliance/check (external draft with an IBAN)", async () => {
    const c = decode(await call("/compliance/check", { method: "POST", body: { draft: sensitiveDraft, language: lang } }), S.ComplianceCheckResponseSchema, { what: "/compliance/check" });
    expect(c.issues.length >= 2, `expected at least 2 compliance issues on an external draft carrying an IBAN, got ${c.issues.length} (${c.issues.map((i) => i.code).join(", ") || "none"})`);
    complianceIssues = c.issues;
    return `verdict=${c.verdict}, ${c.issues.length} issues (${c.issues.map((i) => i.code).join(", ")})`;
  });

  await measure("POST /compliance/phishing (lookalike sender)", async () => {
    const p = decode(await call("/compliance/phishing", { method: "POST", body: { email: phishingEmail } }), S.PhishingCheckResponseSchema, { what: "/compliance/phishing" });
    expect(p.verdict !== "clean", `expected a suspicious/likely_phishing verdict for ${phishingEmail.from.address}, got "${p.verdict}"`);
    expect(p.indicators.length >= 1, "no phishing indicator reported");
    return `verdict=${p.verdict}, score=${p.score}, indicators=${p.indicators.map((i) => i.code).slice(0, 4).join(", ")}`;
  });

  await measure("POST /compliance/escalations", async () => {
    const e = decode(
      await call("/compliance/escalations", { method: "POST", body: { reason: "Smoke test: external draft with an IBAN requires compliance approval", draft: sensitiveDraft, issues: complianceIssues } }),
      S.EscalationSchema,
      { expectStatus: 201, what: "/compliance/escalations" },
    );
    expect(e.status === "pending", `a new escalation must be pending, got "${e.status}"`);
    const list = decode(await call("/compliance/escalations?status=pending"), S.EscalationSchema.array(), { what: "/compliance/escalations (list)" });
    expect(list.some((x) => x.id === e.id), "the new escalation is not in the pending list");
    return `id=${e.id}, status=${e.status}, issues=${e.issues.length}, pending in list=${list.length}`;
  });

  /* -------------------------- 11. automations -------------------------- */
  let automationId;
  await measure("POST /automations/observe (3 identical sequences)", async () => {
    const r = await call("/automations/observe", { method: "POST", body: { events: automationEvents } });
    expect(r.status === 202, `expected HTTP 202, got ${r.status} ${preview(r.body, 160)}`);
    expect(r.json?.stored === automationEvents.length, `stored ${r.json?.stored}/${automationEvents.length} events`);
    return `${r.json.stored} events stored (3 × save_attachment→categorize→create_reminder from ${PARTNER_DOMAIN})`;
  });

  await measure("POST /automations/detect", async () => {
    const list = decode(await call("/automations/detect", { method: "POST", body: {} }), S.AutomationListSchema, { what: "/automations/detect" });
    expect(list.length >= 1, "no automation proposed after 3 identical action sequences");
    const target =
      list.find((a) => a.trigger.conditions.fromDomain === PARTNER_DOMAIN && a.steps.some((s) => s.type === "create_reminder")) ??
      list.find((a) => a.trigger.conditions.fromDomain === PARTNER_DOMAIN) ??
      list[0];
    automationId = target.id;
    return `${list.length} proposal(s), picked "${preview(target.name, 50)}" (${target.steps.map((s) => s.type).join("→")}, ${target.stats.occurrences}×, ~${target.stats.estimatedMinutesSavedPerWeek} min/week saved)`;
  });

  await measure("POST /automations/:id/simulate", async () => {
    expect(automationId, "no automation to simulate");
    const a = decode(await call(`/automations/${automationId}/simulate`, { method: "POST", body: { sampleSize: 10 } }), S.AutomationSchema, { what: "/automations/:id/simulate" });
    expect(a.lastSimulation, "the automation carries no simulation result");
    expect(a.status === "simulated" || a.status === "active", `expected status simulated, got "${a.status}"`);
    const passed = a.lastSimulation.checks.filter((c) => c.passed).length;
    const wouldApply = a.lastSimulation.results.filter((r) => r.wouldApply).length;
    expect(passed === a.lastSimulation.checks.length, `${a.lastSimulation.checks.length - passed} simulation check(s) failed: ${a.lastSimulation.checks.filter((c) => !c.passed).map((c) => `${c.name} (${c.detail})`).join(", ")}`);
    // The sample is the mailbox indexed a few steps earlier, which contains two
    // emails from the trigger domain with an attachment: the rule must fire.
    expect(wouldApply >= 1, `the simulation matched none of the ${a.lastSimulation.sampleSize} sampled emails (trigger: ${JSON.stringify(a.trigger.conditions)})`);
    return `status=${a.status}, sample=${a.lastSimulation.sampleSize}, checks ${passed}/${a.lastSimulation.checks.length} passed, wouldApply=${wouldApply}`;
  });

  await measure("POST /automations/:id/approve", async () => {
    expect(automationId, "no automation to approve");
    const a = decode(await call(`/automations/${automationId}/approve`, { method: "POST", body: { comment: "approved by pnpm smoke --full" } }), S.AutomationSchema, { what: "/automations/:id/approve" });
    expect(a.status === "active", `an approved automation must be active, got "${a.status}"`);
    return `status=${a.status}, risk=${a.riskLevel}, steps=${a.steps.length}`;
  });

  /* -------------------------- 12. daily brief -------------------------- */
  await measure("POST /brief/daily then GET /brief/daily", async () => {
    const posted = decode(await call("/brief/daily", { method: "POST", body: { language: lang, refresh: true } }), S.DailyBriefSchema, { what: "POST /brief/daily" });
    expect(posted.headline.trim().length > 0, "the brief has no headline");
    const got = decode(await call(`/brief/daily?date=${posted.date}`), S.DailyBriefSchema, { what: "GET /brief/daily" });
    expect(got.date === posted.date, `GET returned the brief for ${got.date}, expected ${posted.date}`);
    return `date=${posted.date}, source=${posted.source}, highlights=${posted.highlights.length}, priority=${posted.priorityEmails.length}, new=${posted.stats.newEmails}`;
  });

  /* ------------------------------ 13. audit ---------------------------- */
  await measure("GET /audit", async () => {
    const page = decode(await call("/audit?pageSize=25"), S.AuditPageSchema, { what: "/audit" });
    expect(page.total >= 1, "the audit trail is empty after a full run");
    const types = new Set(page.items.map((i) => i.type));
    expect(types.has("emails_indexed") || types.has("summary_generated"), `the audit page does not contain this run's events (types: ${[...types].slice(0, 5).join(", ")})`);
    return `${page.items.length}/${page.total} events on page ${page.page}, types=${[...types].slice(0, 6).join(", ")}`;
  });

  if (!adminHeaders) {
    skip("GET /audit/stats, /audit/export, /admin/system", "no --admin-token / ADMIN_API_TOKEN (admin-only endpoints)");
  } else {
    await measure("GET /audit/stats (admin)", async () => {
      const s = decode(await call("/audit/stats", { headers: adminHeaders }), S.AuditStatsSchema, { what: "/audit/stats" });
      return `${s.totalActions} actions, summaries=${s.kpis.emailsSummarized}, drafts=${s.kpis.draftsGenerated}, automations=${s.kpis.automationsProposed}/${s.kpis.automationsApproved}, alerts=${s.kpis.complianceAlerts}`;
    });

    await measure("GET /audit/export (admin, CSV)", async () => {
      const r = await request(`${api}/audit/export`, { headers: adminHeaders, timeoutMs });
      expect(r.status === 200, `expected HTTP 200, got ${r.status}`);
      const lines = r.body.trim().split("\n");
      expect(lines.length >= 2, `the CSV export has no data row (${lines.length} line(s))`);
      expect(/id|timestamp/i.test(lines[0]), `the first CSV line does not look like a header: ${preview(lines[0], 80)}`);
      return `${lines.length - 1} data rows, header="${preview(lines[0], 80)}"`;
    });

    await measure("GET /admin/system (admin)", async () => {
      const s = decode(await call("/admin/system", { headers: adminHeaders }), S.SystemStatusSchema, { what: "/admin/system" });
      return `health=${s.health.status}, queue=${s.llmQueue.pending}/${s.llmQueue.running} (circuit ${s.llmQueue.circuitOpen ? "open" : "closed"}), analysis cache ${s.cache.analysisHits}/${s.cache.analysisHits + s.cache.analysisMisses}, embeddings ${s.cache.embeddingHits}/${s.cache.embeddingHits + s.cache.embeddingMisses}, up ${s.uptimeSeconds}s`;
    });
  }

  /* ----------------------------- 14. metrics --------------------------- */
  if (!metricsToken) {
    const m = await request(`${baseUrl}/metrics`, { timeoutMs });
    if (m.status === 200 && m.body.includes("# HELP")) check("GET /metrics", true, `${m.body.split("\n").length} lines (unprotected)`);
    else skip("GET /metrics", m.status === 404 ? "not exposed (METRICS_ENABLED=false)" : "no --metrics-token (METRICS_TOKEN is set — this is the expected production behaviour)");
  } else {
    await measure("GET /metrics", async () => {
      const m = await request(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` }, timeoutMs });
      expect(m.status === 200, `expected HTTP 200, got ${m.status}`);
      expect(m.body.includes("# HELP"), "the body is not a Prometheus exposition");
      const families = new Set(m.body.split("\n").filter((l) => l.startsWith("# HELP")).map((l) => l.split(" ")[2]));
      return `${m.body.split("\n").length} lines, ${families.size} metric families`;
    });
  }

  /* --------------------- 15. probes again (still up) ------------------- */
  await measure("GET /ready and /live after the run", async () => {
    const ready = await call("/ready");
    expect(ready.status === 200, `/ready returned HTTP ${ready.status}: ${preview(ready.body, 200)}`);
    const live = await call("/live");
    expect(live.status === 200, `/live returned HTTP ${live.status}`);
    return `ready=200, live=200, uptime=${live.json?.uptimeSeconds ?? "?"}s`;
  });

  return facts;
}

/* -------------------------------------------------------------------------- */
/*  Run                                                                       */
/* -------------------------------------------------------------------------- */

say.step(`Outlook AI Orchestrator smoke test — ${api}${flags.full ? "  [full]" : ""}`);
if (flags.full) say.info(`user=${token ? "bearer token" : user}, language=${lang}, run id=${RUN}`);

if (waitSeconds > 0) {
  say.step(`Waiting up to ${waitSeconds}s for ${api}/ready`);
  await waitFor(async () => (await request(`${api}/ready`, { timeoutMs: 5000 })).ok, { timeoutMs: waitSeconds * 1000, intervalMs: 2000, label: "readiness" });
}

const startedAt = Date.now();
let facts = {};
if (flags.full) facts = (await runFull()) ?? {};
else await runQuick();
const totalMs = Date.now() - startedAt;

/* ------------------------------ final table ------------------------------- */
const MARK = { pass: "OK  ", fail: "FAIL", skip: "SKIP" };
const width = Math.min(58, Math.max(...results.map((r) => r.step.length)));
if (!jsonMode) {
  console.log("");
  console.log(style.bold(`  ${"STEP".padEnd(width)}  RESULT  DETAIL`));
  console.log(style.dim(`  ${"-".repeat(width)}  ------  ${"-".repeat(40)}`));
  for (const r of results) {
    const paint = r.status === "pass" ? style.green : r.status === "fail" ? style.red : style.yellow;
    const ms = r.ms === undefined ? "" : style.dim(` (${r.ms} ms)`);
    console.log(`  ${r.step.padEnd(width)}  ${paint(MARK[r.status])}    ${preview(r.detail, 110)}${ms}`);
  }
  console.log(style.dim(`  ${"-".repeat(width)}  ------  ${"-".repeat(40)}`));
  const passed = results.filter((r) => r.status === "pass").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  console.log(`  ${passed} passed, ${failures} failed${skipped ? `, ${skipped} skipped` : ""} in ${(totalMs / 1000).toFixed(1)}s`);
  console.log("");
}

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        url: api,
        mode: flags.full ? "full" : "quick",
        language: lang,
        runId: RUN,
        passed: results.filter((r) => r.status === "pass").length,
        failed: failures,
        skipped: results.filter((r) => r.status === "skip").length,
        durationMs: totalMs,
        facts,
        steps: results,
      },
      null,
      2,
    ),
  );
}

if (failures === 0) {
  if (!jsonMode) console.log(style.green(flags.full ? "All features verified end to end." : "All smoke checks passed."));
  process.exit(0);
}
if (!jsonMode) console.error(style.red(`${failures} smoke check(s) FAILED (see above).`));
process.exit(1);

#!/usr/bin/env node
/**
 * `pnpm smoke` — end-to-end smoke test against a running orchestrator.
 *
 * Works out of the box against a demo instance (LLM_PROVIDER=mock,
 * DATABASE_URL=memory, AUTH_MODE=dev) and, with --token, against a real
 * deployment (NKP): probes, metrics, then one call per major feature.
 *
 *   pnpm smoke
 *   pnpm smoke --url https://api.oao.northbridge.example --token "$JWT"
 *   pnpm smoke --wait 60
 *
 * Exit code 0 = all checks passed.
 */
import {
  fail,
  helpIfRequested,
  info,
  loadEnv,
  ok,
  parseArgs,
  preview,
  request,
  step,
  style,
  warn,
  waitFor,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), { booleans: ["help", "h", "quiet"] });

helpIfRequested(
  flags,
  `
Usage: pnpm smoke [options]

Checks a running orchestrator end to end:
  GET  /api/v1/live            liveness probe (Kubernetes)
  GET  /api/v1/ready           readiness probe (dependencies)
  GET  /api/v1/health          aggregated health, per-dependency detail
  GET  /metrics                Prometheus exposition (needs --metrics-token)
  GET  /api/v1/config/features feature flags
  POST /api/v1/analyze/email   summary, decisions, risks
  POST /api/v1/compliance/check  Compliance Guardian verdict
  POST /api/v1/chat            conversational search

Options:
  --url <url>             orchestrator base URL (default $ORCHESTRATOR_URL or
                          http://localhost:8080)
  --token <jwt>           Authorization: Bearer <jwt>  (AUTH_MODE=aad)
  --metrics-token <tok>   bearer token for /metrics (default $METRICS_TOKEN)
  --user <email>          x-user-email header used in AUTH_MODE=dev
  --wait <seconds>        wait for /api/v1/ready before testing (default 0)
  --timeout <ms>          per-request timeout (default 30000)
  -h, --help              show this help
`,
);

const env = loadEnv(undefined, { quiet: true });
const baseUrl = String(flags.url ?? env.ORCHESTRATOR_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const api = `${baseUrl}/api/v1`;
const token = flags.token ?? env.SMOKE_TOKEN ?? "";
const metricsToken = flags["metrics-token"] ?? env.METRICS_TOKEN ?? "";
const user = String(flags.user ?? env.SMOKE_TEST_USER_EMAIL ?? "smoke-test@northbridge.example");
const timeoutMs = Number(flags.timeout ?? 30000);
const waitSeconds = Number(flags.wait ?? 0);

const authHeaders = token
  ? { authorization: `Bearer ${token}` }
  : { "x-user-email": user, "x-user-name": "Smoke Test" };

let failures = 0;
const check = (label, passed, detail) => {
  if (passed) {
    ok(label);
    if (detail && !flags.quiet) info(detail);
  } else {
    failures += 1;
    fail(`${label}${detail ? ` — ${detail}` : ""}`);
  }
};

step(`Outlook AI Orchestrator smoke test — ${api}`);

/* -- optional wait for readiness ------------------------------------------- */
if (waitSeconds > 0) {
  step(`Waiting up to ${waitSeconds}s for ${api}/ready`);
  await waitFor(
    async () => (await request(`${api}/ready`, { timeoutMs: 5000 })).ok,
    { timeoutMs: waitSeconds * 1000, intervalMs: 2000, label: "readiness" },
  );
}

/* -- 1. probes ------------------------------------------------------------- */
const live = await request(`${api}/live`, { timeoutMs });
check("GET /api/v1/live", live.ok, live.ok ? undefined : `HTTP ${live.status} ${live.error ?? ""}`);

const ready = await request(`${api}/ready`, { timeoutMs });
check(
  "GET /api/v1/ready",
  ready.ok,
  ready.ok ? preview(ready.body, 160) : `HTTP ${ready.status} ${preview(ready.body)} ${ready.error ?? ""}`,
);

const health = await request(`${api}/health`, { headers: authHeaders, timeoutMs });
check("GET /api/v1/health", health.ok, preview(health.body, 200));
if (health.json?.status === "degraded") {
  warn("health is 'degraded' — check the per-dependency detail above (LLM / Graph / DB)");
}

/* -- 2. metrics ------------------------------------------------------------ */
const metrics = await request(`${baseUrl}/metrics`, {
  headers: metricsToken ? { authorization: `Bearer ${metricsToken}` } : {},
  timeoutMs,
});
if (metrics.status === 401 || metrics.status === 403) {
  warn("/metrics requires a token — pass --metrics-token (this is the expected production behaviour)");
} else if (metrics.status === 404) {
  warn("/metrics not exposed (METRICS_ENABLED=false?)");
} else {
  check(
    "GET /metrics",
    metrics.ok && metrics.body.includes("# HELP"),
    metrics.ok ? `${metrics.body.split("\n").length} lines` : `HTTP ${metrics.status}`,
  );
}

/* -- 3. features ----------------------------------------------------------- */
const features = await request(`${api}/config/features`, { headers: authHeaders, timeoutMs });
check("GET /api/v1/config/features", features.ok, preview(features.body, 200));

/* -- 4. analyze an email --------------------------------------------------- */
const emailPayload = {
  email: {
    id: "smoke-test-email-1",
    conversationId: "smoke-test-conv-1",
    subject: "Q2 vendor risk assessment — please review",
    from: { name: "A. Vendor", address: "contact@vendor.example" },
    to: [{ name: "Smoke Test", address: user }],
    body:
      "Hi, please find attached the Q2 vendor risk assessment report. There are a few " +
      "high-risk findings that need your review and approval before Friday.",
    attachments: [{ name: "Q2-vendor-risk-assessment.pdf", contentType: "application/pdf" }],
  },
  language: "en",
};
const analyze = await request(`${api}/analyze/email`, {
  method: "POST",
  headers: authHeaders,
  body: emailPayload,
  timeoutMs,
});
check(
  "POST /api/v1/analyze/email",
  analyze.ok,
  analyze.ok ? preview(analyze.body) : `HTTP ${analyze.status} ${preview(analyze.body)}`,
);

/* -- 5. compliance check --------------------------------------------------- */
const compliance = await request(`${api}/compliance/check`, {
  method: "POST",
  headers: authHeaders,
  timeoutMs,
  body: {
    draft: {
      to: [{ name: "External Client", address: "client@clientco.example" }],
      subject: "Q2 Performance Report — Client A",
      body:
        "Hi, attached is the confidential Q2 performance report with portfolio " +
        "account number 123456789.",
      attachments: [{ name: "Client A - Q2 Performance Report.pdf", contentType: "application/pdf" }],
    },
    language: "en",
  },
});
check(
  "POST /api/v1/compliance/check",
  compliance.ok,
  compliance.ok ? preview(compliance.body) : `HTTP ${compliance.status} ${preview(compliance.body)}`,
);

/* -- 6. chat --------------------------------------------------------------- */
const chat = await request(`${api}/chat`, {
  method: "POST",
  headers: authHeaders,
  timeoutMs,
  body: { message: "Find the email where the client approved the mandate.", language: "en" },
});
check(
  "POST /api/v1/chat",
  chat.ok,
  chat.ok ? preview(chat.body) : `HTTP ${chat.status} ${preview(chat.body)}`,
);

/* -- verdict --------------------------------------------------------------- */
console.log("");
if (failures === 0) {
  console.log(style.green("All smoke checks passed."));
  process.exit(0);
}
console.error(style.red(`${failures} smoke check(s) FAILED (see above).`));
process.exit(1);

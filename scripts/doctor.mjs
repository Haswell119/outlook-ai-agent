#!/usr/bin/env node
/**
 * `npm run doctor` — "the add-in does not connect": which link is broken?
 *
 * Checks, from the developer's machine, every hop between Outlook and the
 * orchestrator while `npm run dev` is running, and prints the exact fix for
 * each failure:
 *
 *   1. .env           found, VITE_API_BASE_URL is an origin, CORS allows the pane
 *   2. certificate    the Office dev certificate exists (Outlook refuses a
 *                     self-signed one inside its iframe, with no click-through)
 *   3. add-in :3000   served by *this* repo's Vite dev server (not a Docker
 *                     container), with the trusted certificate, and the API URL
 *                     baked into the running bundle equals the one in .env
 *   4. orchestrator   /health, /ready, CORS preflight from https://localhost:3000,
 *                     features (real LLM or mock), same process as npm run dev
 *   5. database       reachable at the DATABASE_URL host:port
 *   6. manifest       rendered and pointing at https://localhost:3000
 *
 * Nothing is modified. Exit code 1 when at least one check fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { X509Certificate as X509 } from "node:crypto";
import { connect as tlsConnect } from "node:tls";

import { fail, helpIfRequested, info, isWindows, loadEnv, ok, parseArgs, repoRoot, request, step, style, warn } from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), { booleans: ["help", "h"] });
helpIfRequested(
  flags,
  `
Usage: npm run doctor

Run it while \`npm run dev\` is running, in a second terminal. It checks the
chain Outlook -> https://localhost:3000 (add-in) -> orchestrator -> database
and prints the fix for every broken link. Nothing is modified.
`,
);

const ADDIN_ORIGIN = "https://localhost:3000";
let failures = 0;
let warnings = 0;
const bad = (msg, ...fixes) => {
  failures++;
  fail(msg);
  for (const f of fixes) if (f) info(`→ ${f}`);
};
const meh = (msg, ...fixes) => {
  warnings++;
  warn(msg);
  for (const f of fixes) if (f) info(`→ ${f}`);
};

/* ------------------------------ helpers ------------------------------- */

/** GET over https without verifying the certificate (the cert is checked separately). */
function insecureGet(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, body: "", error: e.message }));
    req.end();
  });
}

/** The certificate a TLS server presents (PEM-less: raw DER + subject/issuer). */
function peerCertificate(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = socket.getPeerCertificate(false);
      socket.end();
      resolve(c && c.raw ? c : null);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}

function portOpen(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = createConnection({ host, port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};

/* -------------------------------- 1. env ------------------------------- */

step("1. .env");
const envFile = join(repoRoot, ".env");
if (!existsSync(envFile)) bad(`${envFile} not found`, "npm run setup:dev   (creates .env from .env.example), then fill in your LLM key");
const env = loadEnv(envFile, { quiet: true });
const apiUrl = (env.VITE_API_BASE_URL ?? "").trim();
const apiOrigin = originOf(apiUrl);
if (!apiUrl) bad("VITE_API_BASE_URL is empty", "set VITE_API_BASE_URL=http://localhost:8080 in .env, then restart npm run dev");
else if (!apiOrigin) bad(`VITE_API_BASE_URL is not a URL: "${apiUrl}"`, "VITE_API_BASE_URL=http://localhost:8080");
else if (new URL(apiUrl).pathname.replace(/\/+$/, "") !== "") bad(`VITE_API_BASE_URL must be an origin only, got "${apiUrl}"`, `VITE_API_BASE_URL=${apiOrigin}   (the /api/v1 prefix is added by the add-in)`);
else if (/\.example$/i.test(new URL(apiUrl).hostname)) bad(`VITE_API_BASE_URL is the production placeholder "${apiUrl}"`, "for a local test: VITE_API_BASE_URL=http://localhost:8080, then restart npm run dev");
else ok(`VITE_API_BASE_URL=${apiUrl}`);

const cors = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!cors.includes(ADDIN_ORIGIN) && !cors.includes("*")) bad(`CORS_ORIGINS does not contain ${ADDIN_ORIGIN} (got "${cors.join(",")}")`, `CORS_ORIGINS=${ADDIN_ORIGIN}`);
else ok(`CORS_ORIGINS allows ${ADDIN_ORIGIN}`);

if ((env.AUTH_MODE ?? "dev") !== "dev" && (env.VITE_AUTH_MODE ?? "dev") === "dev") meh(`AUTH_MODE=${env.AUTH_MODE} but the add-in runs VITE_AUTH_MODE=dev: every call will be 401`, "for a local test: AUTH_MODE=dev");
if ((env.VITE_API_MOCK ?? "false") === "true") meh("VITE_API_MOCK=true: the pane shows sample data and never calls the orchestrator", "VITE_API_MOCK=false");
if ((env.LLM_PROVIDER ?? "mock") === "mock") meh("LLM_PROVIDER=mock: answers are simulated, not produced by your model", "LLM_PROVIDER=openai + LLM_BASE_URL + LLM_API_KEY + LLM_MODEL, then npm run check:llm");

/* ---------------------------- 2. certificate --------------------------- */

step("2. HTTPS certificate for https://localhost:3000");
const certDir = join(homedir(), ".office-addin-dev-certs");
const devCertFile = join(certDir, "localhost.crt");
let devCert;
if (!existsSync(devCertFile)) {
  bad(
    `no Office dev certificate in ${certDir}`,
    "npm run certs   (installs a trusted localhost certificate; accept the Windows security prompt), then restart npm run dev",
    "without it the dev server uses a self-signed certificate: the browser tab lets you click through, the Outlook pane does not",
  );
} else {
  try {
    devCert = new X509(readFileSync(devCertFile));
    const expires = new Date(devCert.validTo);
    if (expires.getTime() < Date.now()) bad(`the Office dev certificate expired on ${expires.toISOString().slice(0, 10)}`, "npm run certs -- --force, then restart npm run dev");
    else ok(`Office dev certificate present (valid until ${expires.toISOString().slice(0, 10)})`);
  } catch (e) {
    bad(`cannot read ${devCertFile}: ${e.message}`, "npm run certs");
  }
  if (isWindows) {
    // spawnSync without a shell: the pipe must reach PowerShell, not cmd.exe.
    const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -like '*Developer CA for Microsoft Office Add-ins*' }).Count"], { encoding: "utf8", timeout: 15000 });
    const count = Number(String(ps.stdout ?? "").trim() || "0");
    if (ps.status === 0 && count === 0) bad("the Office dev CA is not in your Windows trusted roots (Current User)", "npm run certs   and accept the Windows prompt « Voulez-vous installer ce certificat ? »");
    else if (ps.status === 0) ok("Office dev CA trusted by Windows (Current User\\Root)");
  }
}

/* ------------------------------ 3. add-in ------------------------------ */

step("3. Add-in dev server (https://localhost:3000)");
const pane = await insecureGet(`${ADDIN_ORIGIN}/taskpane.html`);
if (!pane.status) {
  bad(`nothing answers on ${ADDIN_ORIGIN} (${pane.error})`, "start it: npm run dev   (look for « [addin] ➜ Local: https://localhost:3000/ »)", "if Vite printed another port (3002…), port 3000 is taken: close what uses it and restart");
} else if (pane.status !== 200) {
  bad(`${ADDIN_ORIGIN}/taskpane.html answered HTTP ${pane.status}`, "restart npm run dev");
} else {
  const vite = await insecureGet(`${ADDIN_ORIGIN}/@vite/client`);
  if (vite.status !== 200) {
    bad(
      "port 3000 is served by something else than this repo's `npm run dev` (probably the Docker « addin » container)",
      "stop the full Docker stack: docker compose down   (keep only the database: npm run dev:db)",
      "then restart npm run dev",
    );
  } else ok("taskpane.html served by the Vite dev server of this repo");

  const served = await peerCertificate("localhost", 3000);
  if (served && devCert) {
    const same = Buffer.compare(Buffer.from(served.raw), Buffer.from(devCert.raw)) === 0;
    if (same) ok("the dev server presents the Office dev certificate");
    else bad(`the dev server presents another certificate (subject: ${served.subject?.CN ?? "?"}, issuer: ${served.issuer?.CN ?? "?"}) — Outlook will not load the pane`, "restart npm run dev (Vite picks the Office certificate up at start)");
  } else if (served && !devCert) {
    meh(`the dev server presents a self-signed certificate (CN=${served.subject?.CN ?? "?"})`, "npm run certs, then restart npm run dev");
  }

  if (vite.status === 200) {
    const mod = await insecureGet(`${ADDIN_ORIGIN}/src/api/index.ts`);
    const m = /import\.meta\.env = (\{.*?\});/.exec(mod.body);
    let baked;
    try {
      baked = m ? JSON.parse(m[1]) : undefined;
    } catch {
      baked = undefined;
    }
    if (!baked) meh("could not read the API URL the running add-in uses");
    else {
      const used = String(baked.VITE_API_BASE_URL ?? "");
      if (baked.VITE_API_MOCK === "true") bad("the running add-in is in mock mode (VITE_API_MOCK=true)", "set VITE_API_MOCK=false in .env and in apps/addin/.env if present, then restart npm run dev");
      if (!used) bad("the running add-in has no VITE_API_BASE_URL", "set it in .env, then restart npm run dev");
      else if (apiUrl && used.replace(/\/+$/, "") !== apiUrl.replace(/\/+$/, "")) {
        bad(`the running add-in calls ${used}, but .env says ${apiUrl}`, "Vite reads .env only at start: stop npm run dev (Ctrl+C) and start it again", existsSync(join(repoRoot, "apps", "addin", ".env")) ? "apps/addin/.env exists and overrides the root .env: fix or delete it" : "");
      } else ok(`the running add-in calls ${used}`);
    }
  }
}

/* --------------------------- 4. orchestrator --------------------------- */

step(`4. Orchestrator (${apiOrigin ?? "?"})`);
if (apiOrigin) {
  const health = await request(`${apiOrigin}/api/v1/health`, { timeoutMs: 8000 });
  if (!health.status) {
    const u = new URL(apiOrigin);
    bad(
      `the orchestrator does not answer on ${apiOrigin} (${health.error})`,
      "look at the [orch] lines of npm run dev: an error there (database, port 8080 in use, .env) stops it",
      `port ${u.port || 80} in use by another process? on Windows: netstat -ano | findstr :${u.port || 80}`,
      "it takes ~20 s the first time (migrations + demo data): wait for « Outlook AI Orchestrator listening »",
    );
  } else {
    if (health.status === 200) ok(`/health → ${health.json?.status ?? "ok"}`);
    else meh(`/health → HTTP ${health.status} ${health.json?.status ?? ""}`, "details: " + Object.entries(health.json?.checks ?? {}).filter(([, c]) => c.status !== "ok").map(([k, c]) => `${k}: ${c.detail ?? c.status}`).join("; "));
    const ready = await request(`${apiOrigin}/api/v1/ready`, { timeoutMs: 8000 });
    if (ready.status === 200) ok("/ready → 200");
    else bad(`/ready → HTTP ${ready.status}: ${String(ready.body).slice(0, 200)}`, "the orchestrator is up but not ready (database / vector store): see the [orch] log lines");

    // The exact preflight the pane's browser sends before a POST.
    try {
      const pre = await fetch(`${apiOrigin}/api/v1/analyze/email`, {
        method: "OPTIONS",
        headers: { Origin: ADDIN_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-correlation-id,x-user-email,x-user-name,accept-language" },
        signal: AbortSignal.timeout(8000),
      });
      const allowed = pre.headers.get("access-control-allow-origin");
      if (allowed === ADDIN_ORIGIN || allowed === "*") ok(`CORS preflight from ${ADDIN_ORIGIN} accepted`);
      else bad(`CORS preflight from ${ADDIN_ORIGIN} rejected (HTTP ${pre.status}, allow-origin=${allowed ?? "none"})`, `CORS_ORIGINS=${ADDIN_ORIGIN} in .env, then restart npm run dev`);
    } catch (e) {
      bad(`CORS preflight failed: ${e.message}`);
    }

    const feats = await request(`${apiOrigin}/api/v1/config/features`, { headers: { "x-user-email": "doctor@localhost", "x-user-name": "Doctor" }, timeoutMs: 8000 });
    if (feats.ok && feats.json) {
      const f = feats.json;
      ok(`features: llm=${f.llmProvider}/${f.llmModel}, embeddings=${f.embeddingsEnabled}, graph=${f.graphEnabled}, v${f.version}`);
      if (f.llmProvider === "mock" && (env.LLM_PROVIDER ?? "mock") !== "mock") {
        bad(
          `the orchestrator on ${apiOrigin} runs the mock model although .env says LLM_PROVIDER=${env.LLM_PROVIDER}`,
          "this is not the npm run dev orchestrator (a Docker « orchestrator » container?) or it did not read .env",
          "docker compose down, then restart npm run dev and check « envFiles » in its first log line",
        );
      }
    } else if (feats.status === 401) {
      bad("/config/features → 401: the orchestrator does not run AUTH_MODE=dev", "AUTH_MODE=dev in .env for a local test, then restart npm run dev");
    } else meh(`/config/features → HTTP ${feats.status}`);
  }
}

/* ----------------------------- 5. database ----------------------------- */

step("5. Database");
const dbUrl = (env.DATABASE_URL ?? "memory").trim();
if (dbUrl === "memory") ok("DATABASE_URL=memory (no PostgreSQL needed; data is lost at each restart)");
else {
  try {
    const u = new URL(dbUrl);
    const host = u.hostname || "localhost";
    const port = Number(u.port || 5432);
    if (await portOpen(host, port)) ok(`PostgreSQL reachable on ${host}:${port}`);
    else bad(`nothing listens on ${host}:${port} (DATABASE_URL)`, "npm run dev:db   (starts the PostgreSQL container), then npm run db:migrate");
  } catch {
    bad(`DATABASE_URL is not a URL: "${dbUrl.replace(/:[^:@/]*@/, ":***@")}"`, "DATABASE_URL=postgres://oao:<password>@localhost:5432/oao");
  }
}

/* ----------------------------- 6. manifest ----------------------------- */

step("6. Manifest");
const manifest = join(repoRoot, "apps", "addin", "manifest", "manifest.dev.xml");
if (!existsSync(manifest)) bad("apps/addin/manifest/manifest.dev.xml is missing", "npm run manifest:render");
else {
  const xml = readFileSync(manifest, "utf8");
  if (xml.includes("https://localhost:3000/taskpane.html")) ok("manifest.dev.xml points at https://localhost:3000");
  else bad("manifest.dev.xml does not point at https://localhost:3000", "npm run manifest:render, then remove and re-add the add-in in Outlook");
}

/* ------------------------------- summary ------------------------------- */

console.log("");
if (failures) {
  console.log(style.red(`${failures} problem(s) found`) + (warnings ? `, ${warnings} warning(s)` : "") + " — fix the first FAIL first, the next ones often follow from it.");
} else {
  console.log(style.green("The local chain is healthy.") + (warnings ? ` ${warnings} warning(s) above.` : ""));
  console.log(
    [
      "If the pane still does not connect inside Outlook, the rest happens in the browser:",
      "  1. In the SAME browser, open https://localhost:3000/taskpane.html: no certificate warning must appear.",
      "  2. Edge/Chrome may ask to let outlook.live.com / outlook.office.com « access devices on your local network »:",
      "     click the icon at the left of the address bar and allow it (or reset it if it was blocked).",
      "  3. Reload Outlook with Ctrl+F5, then re-open the add-in. The pane's error message shows the URL it tried.",
    ].join("\n"),
  );
}
process.exit(failures ? 1 : 0);

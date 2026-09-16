// Must run before anything reads process.env (side-effect import).
import { LOADED_ENV_FILES } from "./env-file.js";
import pino from "pino";
import { buildApp } from "./app.js";
import { APP_VERSION, ConfigError, effectiveConfig, isMemoryDatabase, loadConfigDetailed, runsWorkers, servesApi, type Config } from "./config.js";
import { createContainer } from "./container.js";
import { seedDemo } from "./seed/demo.js";
import { createScheduler } from "./workers/index.js";

/* ----------------------------- configuration ---------------------------- */

let cfg: Config;
let secretsFromFiles: string[] = [];
try {
  const loaded = loadConfigDetailed();
  cfg = loaded.cfg;
  secretsFromFiles = loaded.secretsFromFiles;
} catch (e) {
  // Fail fast with the *complete* list of problems, on stderr, before any logger exists.
  if (e instanceof ConfigError) {
    console.error(`\nOutlook AI Orchestrator: invalid configuration (${e.problems.length} problem${e.problems.length > 1 ? "s" : ""})\n`);
    for (const p of e.problems) console.error(`  ✗ ${p}`);
    console.error("\nSee apps/orchestrator/.env.example for every variable and its default.\n");
  } else {
    console.error(e);
  }
  process.exit(78); // EX_CONFIG
}

/* --------------------------------- logging ------------------------------- */

/**
 * Redaction is not optional here: an email body or a bearer token in a log line
 * is a data-protection incident. pino's `redact` is applied at serialisation
 * time, so it also covers objects we did not write ourselves (Fastify's own
 * request/response serialisers included).
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-metrics-token']",
  "req.headers['idempotency-key']",
  "res.headers['set-cookie']",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.clientSecret",
  "*.password",
  "*.body",
  "*.bodyPreview",
  "email.body",
  "draft.body",
  "*.email.body",
  "*.draft.body",
  "prompt",
  "*.prompt",
  "response",
  "*.raw",
];

const logger = pino({
  level: cfg.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  base: { service: "oao-orchestrator", role: cfg.ROLE, version: APP_VERSION },
  ...(cfg.LOG_FORMAT === "pretty" ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}),
});

logger.info({ config: effectiveConfig(cfg), secretsFromFiles, envFiles: LOADED_ENV_FILES }, "effective configuration (secrets redacted)");

/* -------------------------------- container ------------------------------ */

const container = await createContainer(cfg, { logger });
if (isMemoryDatabase(cfg) && cfg.DEMO_SEED) {
  const r = await seedDemo(container);
  logger.info(r, "demo data seeded into memory repositories");
}

/* --------------------------------- workers ------------------------------- */

const scheduler = runsWorkers(cfg) ? createScheduler(container, container.pool) : undefined;
if (scheduler) {
  await scheduler.start();
  logger.info({ jobs: scheduler.status.map((j) => j.name), leader: scheduler.isLeader }, "scheduler started");
}

/* ----------------------------------- API --------------------------------- */

const app = servesApi(cfg) ? await buildApp(container, { loggerInstance: logger }) : undefined;
if (app) {
  try {
    await app.listen({ port: cfg.PORT, host: cfg.HOST });
    logger.info(
      {
        version: APP_VERSION,
        role: cfg.ROLE,
        llm: `${container.deps.llm.name}/${container.deps.llm.model}${cfg.LLM_FAST_MODEL ? ` (+fast: ${cfg.LLM_FAST_MODEL})` : ""}`,
        db: isMemoryDatabase(cfg) ? "memory" : "postgres",
        auth: cfg.AUTH_MODE,
        graph: cfg.GRAPH_ENABLED ? cfg.GRAPH_AUTH_MODE : false,
        triage: cfg.TRIAGE_ENABLED,
        cache: cfg.ANALYSIS_CACHE_ENABLED,
        precompute: cfg.PRECOMPUTE_ENABLED,
      },
      `Outlook AI Orchestrator listening on http://${cfg.HOST}:${cfg.PORT}${cfg.API_DOCS_ENABLED ? " (docs: /api/v1/docs)" : ""}`,
    );
  } catch (e) {
    logger.error(e, "failed to start");
    process.exit(1);
  }
} else {
  logger.info({ role: cfg.ROLE }, "worker-only role: HTTP server not started");
}

/* ----------------------------- graceful shutdown ------------------------- */

/**
 * SIGTERM contract with Kubernetes:
 *  1. stop the scheduler (no new background work),
 *  2. `app.close()` — Fastify stops accepting connections and lets in-flight
 *     requests finish,
 *  3. close the pool,
 *  4. hard-exit after `SHUTDOWN_TIMEOUT_MS` (default 25 s, below the usual
 *     30 s `terminationGracePeriodSeconds`) so a stuck request cannot turn a
 *     rolling update into a hung deployment.
 */
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, timeoutMs: cfg.SHUTDOWN_TIMEOUT_MS }, "shutting down");
  const kill = setTimeout(() => {
    logger.error({ signal }, "graceful shutdown timed out, exiting now");
    process.exit(1);
  }, cfg.SHUTDOWN_TIMEOUT_MS);
  kill.unref();
  try {
    await scheduler?.stop();
    await app?.close();
    await container.close();
    logger.info({ signal }, "shutdown complete");
    process.exit(0);
  } catch (e) {
    logger.error({ err: (e as Error).message }, "error during shutdown");
    process.exit(1);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "uncaught exception");
  void shutdown("uncaughtException");
});

import type { FastifyInstance } from "fastify";
import { FeatureFlagsSchema, HealthSchema, Routes, SystemStatusSchema, UserIdentitySchema } from "@oao/shared";
import { APP_VERSION } from "../../config.js";
import type { Container } from "../../container.js";
import { AppError } from "../../errors.js";

/**
 * System endpoints.
 *
 * Probe semantics (Kubernetes):
 *  - `GET /api/v1/live`  — liveness: 200 as soon as the process is up. It never
 *    touches a dependency, so a slow database can never trigger a pod restart.
 *  - `GET /api/v1/ready` — readiness: database reachable **and** migrations
 *    applied. An LLM, Graph or decision-engine (Laya) outage does **not** make
 *    the pod unready: the service still answers (heuristics, LLM fallback),
 *    and removing it from the Service would turn a degradation into an outage.
 *  - `GET /api/v1/health` — unchanged detailed view (used by the runbook).
 */
export async function systemRoutes(app: FastifyInstance, c: Container) {
  app.get(Routes.live, async (_req, reply) => reply.status(200).send({ status: "ok", version: APP_VERSION, role: c.cfg.ROLE, uptimeSeconds: Math.round((Date.now() - c.startedAt) / 1000) }));

  app.get(Routes.ready, async (_req, reply) => {
    const r = await c.ready();
    c.metrics.dbUp.set(r.ok ? 1 : 0);
    return reply.status(r.ok ? 200 : 503).send({ status: r.ok ? "ok" : "unready", detail: r.detail, version: APP_VERSION });
  });

  app.get(Routes.health, async () => {
    const [db, llm, laya] = await Promise.all([c.deps.repos.ping(2000), c.deps.llm.ping(2000), decisionCheck(c)]);
    const queue = c.llmQueue?.stats;
    const checks = {
      database: { status: db.ok ? "ok" : "down", detail: db.detail },
      llm: { status: llm.ok && !queue?.circuitOpen ? "ok" : "degraded", detail: queue?.circuitOpen ? `circuit open after ${queue.consecutiveFailures} failures` : llm.detail },
      graph: { status: c.cfg.GRAPH_ENABLED ? "ok" : "degraded", detail: c.cfg.GRAPH_ENABLED ? `enabled (${c.cfg.GRAPH_AUTH_MODE})` : "disabled (GRAPH_ENABLED=false) — client fallbacks" },
      workers: {
        status: c.cfg.WORKERS_ENABLED && c.cfg.ROLE !== "api" ? "ok" : "degraded",
        detail: c.cfg.ROLE === "api" ? "API-only role (ROLE=api)" : c.cfg.WORKERS_ENABLED ? `scheduler enabled (precompute=${c.cfg.PRECOMPUTE_ENABLED})` : "WORKERS_ENABLED=false",
      },
      vectors: vectorCheck(c),
      // Present only when DECISION_PROVIDER is enabled; never "down" (the engine is optional by design).
      ...(laya ? { laya } : {}),
    } as const;
    const vectors = checks.vectors;
    const status = !db.ok ? "down" : !llm.ok || queue?.circuitOpen || vectors.status === "down" || laya?.affectsUsers ? "degraded" : "ok";
    return HealthSchema.parse({ status, checks: stripInternal(checks), version: APP_VERSION, timestamp: new Date().toISOString() });
  });

  app.get(Routes.features, async () => FeatureFlagsSchema.parse(features(c)));

  app.get(Routes.me, async (req) => UserIdentitySchema.parse({ id: req.user.id, email: req.user.email, displayName: req.user.displayName, tenantId: req.user.tenantId, roles: req.user.roles }));

  /**
   * `GET /metrics` — Prometheus exposition. Outside `/api/v1` on purpose so a
   * NetworkPolicy / ServiceMonitor can target it separately. Protected by
   * `METRICS_TOKEN` when set (constant-time compare).
   */
  app.get(Routes.metrics, async (req, reply) => {
    if (!c.cfg.METRICS_ENABLED) throw AppError.notFound("Metrics endpoint");
    if (c.cfg.METRICS_TOKEN) {
      const auth = req.headers.authorization ?? "";
      const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : (req.headers["x-metrics-token"] as string | undefined);
      if (!bearer || !timingSafeEqual(bearer, c.cfg.METRICS_TOKEN)) throw AppError.unauthorized("Invalid metrics token");
    }
    // Gauges are sampled at scrape time, which is the cheapest place to do it.
    const queue = c.llmQueue?.stats;
    if (queue) {
      c.metrics.llmQueueDepth.set({ lane: "pending" }, queue.pending);
      c.metrics.llmQueueDepth.set({ lane: "running" }, queue.running);
      c.metrics.llmQueueRunning.set(queue.running);
      c.metrics.llmCircuitOpen.set(queue.circuitOpen ? 1 : 0);
    }
    if (c.decisionResilience) c.metrics.setLayaCircuit(c.decisionResilience.circuitState);
    const { contentType, body } = await c.metrics.render();
    return reply.header("content-type", contentType).send(body);
  });
}

/**
 * Vector-store check for `/health`.
 *
 * `down`     — the column disagrees with `EMBEDDING_DIMENSIONS` (a configuration
 *              error: every embedding write would fail). `/ready` is 503 too
 *              unless `DB_AUTO_MIGRATE` already fixed it.
 * `degraded` — no pgvector: lexical search only, which is a supported mode.
 * `ok`       — vectors are stored and queried.
 */
export function vectorCheck(c: Container): { status: "ok" | "degraded" | "down"; detail: string } {
  const v = c.vectorStore;
  if (!v) return { status: c.cfg.EMBEDDINGS_ENABLED ? "ok" : "degraded", detail: c.cfg.EMBEDDINGS_ENABLED ? "in-memory / external repositories (no vector column to check)" : "EMBEDDINGS_ENABLED=false — lexical search only" };
  if (v.mismatch) return { status: "down", detail: v.mismatch };
  if (!v.pgvector) return { status: "degraded", detail: v.detail };
  return { status: "ok", detail: `${v.detail}${v.redimensioned ? " (re-dimensioned at boot: stored embeddings were discarded, re-index to recompute them)" : ""}` };
}

/**
 * Decision-engine check for `/health` (undefined when disabled). `degraded`
 * whenever the engine is unreachable or its circuit is open — it is optional:
 * `/ready` never looks at it. `affectsUsers` (active mode only) also degrades
 * the overall status: in shadow mode nobody sees the difference.
 */
export async function decisionCheck(c: Container): Promise<{ status: "ok" | "degraded"; detail?: string; affectsUsers: boolean } | undefined> {
  const svc = c.services.emailDecision;
  if (!svc.enabled) return undefined;
  const h = await svc.health();
  const ok = h.state === "ok";
  return { status: ok ? "ok" : "degraded", detail: `${h.state}: ${h.detail ?? ""}`.trim(), affectsUsers: !ok && svc.mode === "active" };
}

/** Drop fields that are not part of the `Health` contract. */
function stripInternal<T extends Record<string, unknown>>(checks: T): Record<string, { status: "ok" | "degraded" | "down"; detail?: string }> {
  return Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, { status: (v as { status: "ok" | "degraded" | "down" }).status, detail: (v as { detail?: string }).detail }]));
}

/** True when embeddings are configured **and** effectively storable/queryable. */
export const embeddingsEffective = (c: Container): boolean => c.services.indexEmails.embeddingsAvailable && (c.vectorStore ? c.vectorStore.usable : true);

/** Feature flags shared by `/config/features` and `/admin/system`. */
export function features(c: Container) {
  return {
    graphEnabled: c.cfg.GRAPH_ENABLED,
    embeddingsEnabled: embeddingsEffective(c),
    llmProvider: c.deps.llm.name,
    llmModel: c.deps.llm.model,
    llmFastModel: c.cfg.LLM_FAST_MODEL,
    embeddingModel: c.deps.embeddings?.model,
    authMode: c.cfg.AUTH_MODE,
    precomputeEnabled: c.services.mailboxSync.enabled,
    dailyBriefEnabled: c.cfg.DAILY_BRIEF_ENABLED,
    organizationName: c.cfg.ORGANIZATION_NAME,
    version: APP_VERSION,
  };
}

/** Admin: full runtime status (queues, caches, workers, sync). */
export async function systemStatus(c: Container, userId?: string) {
  const [db, llm, decisioning] = await Promise.all([c.deps.repos.ping(2000), c.deps.llm.ping(2000), c.services.emailDecision.status()]);
  const queue = c.llmQueue?.stats;
  const cache = c.services.cache.stats;
  const embedding = c.embeddingCache?.stats ?? { hits: 0, misses: 0 };
  const sync = userId ? await c.services.mailboxSync.status(userId).catch(() => undefined) : undefined;
  return SystemStatusSchema.parse({
    health: {
      status: !db.ok ? "down" : !llm.ok || queue?.circuitOpen || (decisioning.provider !== "disabled" && decisioning.mode === "active" && decisioning.state !== "ok") ? "degraded" : "ok",
      checks: {
        database: { status: db.ok ? "ok" : "down", detail: db.detail },
        llm: { status: llm.ok && !queue?.circuitOpen ? "ok" : "degraded", detail: queue?.circuitOpen ? "circuit open" : llm.detail },
        vectors: vectorCheck(c),
        ...(decisioning.provider !== "disabled" ? { laya: { status: decisioning.state === "ok" ? "ok" : "degraded", detail: `${decisioning.state}: ${decisioning.detail ?? ""}`.trim() } } : {}),
      },
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
    },
    features: features(c),
    llmQueue: {
      pending: queue?.pending ?? 0,
      running: queue?.running ?? 0,
      concurrency: queue?.concurrency ?? c.cfg.LLM_CONCURRENCY,
      avgLatencyMs: queue?.avgLatencyMs,
      circuitOpen: queue?.circuitOpen ?? false,
    },
    cache: { analysisHits: cache.hits, analysisMisses: cache.misses, embeddingHits: embedding.hits, embeddingMisses: embedding.misses },
    sync,
    decisioning,
    uptimeSeconds: Math.round((Date.now() - c.startedAt) / 1000),
  });
}

/** Length-independent comparison so the metrics token cannot be probed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

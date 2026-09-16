import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { LlmCallSample } from "./adapters/llm/queue.js";

/**
 * Prometheus metrics (`GET /metrics`, protected by `METRICS_TOKEN` when set).
 *
 * The four families that matter for this product:
 *  - **HTTP**: request rate, latency and errors per route — the SLO.
 *  - **LLM**: calls, latency, queue wait and tokens per model & outcome. This is
 *    the GPU bill; `oao_llm_calls_total{outcome="ok"}` over
 *    `oao_http_requests_total` is the "model calls per request" ratio that the
 *    AI-load work is judged on.
 *  - **Caches / triage**: hit ratio and how many emails never reached the model.
 *  - **Workers**: sync lag, precomputed analyses, audit volume.
 *
 * One registry per process, owned by this module so tests can build a fresh one.
 */
export class Metrics {
  readonly registry: Registry;

  readonly httpRequests: Counter<"method" | "route" | "status">;
  readonly httpDuration: Histogram<"method" | "route" | "status">;

  readonly llmCalls: Counter<"model" | "use_case" | "outcome" | "priority">;
  readonly llmDuration: Histogram<"model" | "use_case">;
  readonly llmQueueWait: Histogram<"model" | "priority">;
  readonly llmTokens: Counter<"model" | "kind">;
  readonly llmQueueDepth: Gauge<"lane">;
  readonly llmCircuitOpen: Gauge<string>;

  readonly cacheEvents: Counter<"cache" | "result">;
  /** Flat aliases consumed by the Helm chart's PrometheusRule / Grafana dashboard. */
  readonly cacheHits: Counter<"cache">;
  readonly cacheMisses: Counter<"cache">;
  readonly llmQueueRunning: Gauge<string>;
  readonly dbUp: Gauge<string>;
  readonly buildInfo: Gauge<"version" | "role">;
  readonly coalesced: Counter<"kind">;
  readonly triage: Counter<"kind" | "skipped">;
  readonly modelCallsSaved: Counter<"reason">;

  readonly syncRuns: Counter<"outcome" | "mode">;
  readonly syncLag: Gauge<"user">;
  readonly syncMessages: Counter<"stage">;
  readonly precomputedAnalyses: Gauge<string>;
  readonly auditEvents: Counter<"type">;
  readonly briefs: Counter<"source">;

  constructor(opts: { defaultMetrics?: boolean; prefix?: string; version?: string; role?: string } = {}) {
    const prefix = opts.prefix ?? "oao_";
    this.registry = new Registry();
    if (opts.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry, prefix });

    const reg = [this.registry];
    this.httpRequests = new Counter({ name: `${prefix}http_requests_total`, help: "HTTP requests by route and status", labelNames: ["method", "route", "status"] as const, registers: reg });
    this.httpDuration = new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status"] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: reg,
    });

    this.llmCalls = new Counter({ name: `${prefix}llm_calls_total`, help: "Model calls by model, use case and outcome", labelNames: ["model", "use_case", "outcome", "priority"] as const, registers: reg });
    this.llmDuration = new Histogram({
      name: `${prefix}llm_call_duration_seconds`,
      help: "Model call duration in seconds (excluding queue wait)",
      labelNames: ["model", "use_case"] as const,
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60, 120],
      registers: reg,
    });
    this.llmQueueWait = new Histogram({
      name: `${prefix}llm_queue_wait_seconds`,
      help: "Time spent waiting for an LLM concurrency slot",
      labelNames: ["model", "priority"] as const,
      buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 30],
      registers: reg,
    });
    this.llmTokens = new Counter({ name: `${prefix}llm_tokens_total`, help: "Estimated or reported tokens by model and kind", labelNames: ["model", "kind"] as const, registers: reg });
    this.llmQueueDepth = new Gauge({ name: `${prefix}llm_queue_depth`, help: "Requests waiting for / holding an LLM slot", labelNames: ["lane"] as const, registers: reg });
    this.llmCircuitOpen = new Gauge({ name: `${prefix}llm_circuit_open`, help: "1 when the LLM circuit breaker is open", registers: reg });

    this.cacheEvents = new Counter({ name: `${prefix}cache_events_total`, help: "Cache hits and misses by cache", labelNames: ["cache", "result"] as const, registers: reg });
    this.cacheHits = new Counter({ name: `${prefix}cache_hits_total`, help: "Cache hits by cache (alias of cache_events_total{result=\"hit\"})", labelNames: ["cache"] as const, registers: reg });
    this.cacheMisses = new Counter({ name: `${prefix}cache_misses_total`, help: "Cache misses by cache (alias of cache_events_total{result=\"miss\"})", labelNames: ["cache"] as const, registers: reg });
    this.llmQueueRunning = new Gauge({ name: `${prefix}llm_queue_running`, help: "Requests currently holding an LLM slot", registers: reg });
    this.dbUp = new Gauge({ name: `${prefix}db_up`, help: "1 when the database answered the last readiness check", registers: reg });
    this.buildInfo = new Gauge({ name: `${prefix}build_info`, help: "Build information (always 1)", labelNames: ["version", "role"] as const, registers: reg });
    this.buildInfo.set({ version: opts.version ?? "unknown", role: opts.role ?? "api" }, 1);
    this.coalesced = new Counter({ name: `${prefix}coalesced_requests_total`, help: "Requests that joined an identical in-flight request", labelNames: ["kind"] as const, registers: reg });
    this.triage = new Counter({ name: `${prefix}triage_total`, help: "Emails triaged by kind, and whether the model call was skipped", labelNames: ["kind", "skipped"] as const, registers: reg });
    this.modelCallsSaved = new Counter({ name: `${prefix}model_calls_saved_total`, help: "Model calls avoided, by reason (triage, cache, precomputed, coalesced)", labelNames: ["reason"] as const, registers: reg });

    this.syncRuns = new Counter({ name: `${prefix}mailbox_sync_runs_total`, help: "Mailbox sync runs by outcome and auth mode", labelNames: ["outcome", "mode"] as const, registers: reg });
    this.syncLag = new Gauge({ name: `${prefix}mailbox_sync_lag_seconds`, help: "Seconds since the last successful sync, per mailbox", labelNames: ["user"] as const, registers: reg });
    this.syncMessages = new Counter({ name: `${prefix}mailbox_sync_messages_total`, help: "Messages handled by the sync worker by stage", labelNames: ["stage"] as const, registers: reg });
    this.precomputedAnalyses = new Gauge({ name: `${prefix}precomputed_analyses`, help: "Live precomputed analyses across all mailboxes", registers: reg });
    this.auditEvents = new Counter({ name: `${prefix}audit_events_total`, help: "Audit events written, by type", labelNames: ["type"] as const, registers: reg });
    this.briefs = new Counter({ name: `${prefix}daily_briefs_total`, help: "Daily briefs generated, by source", labelNames: ["source"] as const, registers: reg });
  }

  /** Fed by the LLM queue's `onCall` hook. */
  observeLlmCall(s: LlmCallSample): void {
    this.llmCalls.inc({ model: s.model, use_case: s.useCase, outcome: s.outcome, priority: s.priority });
    if (s.outcome === "ok") {
      this.llmDuration.observe({ model: s.model, use_case: s.useCase }, s.latencyMs / 1000);
      if (s.promptTokens) this.llmTokens.inc({ model: s.model, kind: "prompt" }, s.promptTokens);
      if (s.completionTokens) this.llmTokens.inc({ model: s.model, kind: "completion" }, s.completionTokens);
    }
    if (s.outcome !== "circuit_open") this.llmQueueWait.observe({ model: s.model, priority: s.priority }, s.waitMs / 1000);
  }

  cacheHit(cache: string, n = 1): void {
    this.cacheEvents.inc({ cache, result: "hit" }, n);
    this.cacheHits.inc({ cache }, n);
  }
  cacheMiss(cache: string, n = 1): void {
    this.cacheEvents.inc({ cache, result: "miss" }, n);
    this.cacheMisses.inc({ cache }, n);
  }

  /** Prometheus exposition text. */
  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

/** Fastify route ids are already low-cardinality; unknown routes collapse to `unmatched`. */
export function routeLabel(routerPath: string | undefined, url: string): string {
  if (routerPath) return routerPath;
  // Never label with a raw URL: ids would explode the cardinality.
  return url.startsWith("/metrics") ? "/metrics" : "unmatched";
}

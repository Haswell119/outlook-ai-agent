import type { Config } from "./config.js";
import { APP_VERSION, isMemoryDatabase } from "./config.js";
import { createPgRepositories } from "./adapters/db/index.js";
import { migrationsUpToDate, runMigrations } from "./adapters/db/migrate.js";
import { createPool, type PgPool } from "./adapters/db/pool.js";
import { ensureVectorDimensions, unknownVectorStore, type VectorStoreState } from "./adapters/db/vector-dimensions.js";
import { CachedEmbeddingProvider } from "./adapters/llm/cached-embeddings.js";
import { DisabledGraphClient, MsalGraphClient } from "./adapters/graph/client.js";
import { MockEmbeddingProvider, MockLlmProvider } from "./adapters/llm/mock.js";
import { OpenAiCompatibleProvider } from "./adapters/llm/openai-compatible.js";
import { QueuedLlmProvider } from "./adapters/llm/queue.js";
import { createMemoryRepositories } from "./adapters/memory/index.js";
import { WebhookNotifier } from "./adapters/notify/webhook.js";
import { Metrics } from "./metrics.js";
import type { EmbeddingProvider, LlmProvider } from "./ports/llm.js";
import type { GraphClient } from "./ports/graph.js";
import type { Notifier } from "./ports/notifier.js";
import type { Repositories } from "./ports/repositories.js";
import type { Logger, ServiceDeps } from "./services/context.js";
import { createServices, type Services } from "./services/index.js";

export interface Container {
  cfg: Config;
  deps: ServiceDeps;
  services: Services;
  metrics: Metrics;
  /** LLM queue / circuit breaker (undefined only when an override bypassed it). */
  llmQueue?: QueuedLlmProvider;
  /** Embedding cache wrapper, when embeddings are enabled. */
  embeddingCache?: CachedEmbeddingProvider;
  /** Postgres pool, when not in memory mode (readiness probe, leader election). */
  pool?: PgPool;
  /**
   * Result of the boot-time vector dimension guard. `undefined` in memory mode
   * (nothing to check) — `usable: false` with a `mismatch` makes the instance
   * unready in production.
   */
  vectorStore?: VectorStoreState;
  /** Process start, for `SystemStatus.uptimeSeconds`. */
  startedAt: number;
  /** True when DB reachable + migrations applied (readiness). */
  ready(): Promise<{ ok: boolean; detail?: string }>;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  repos?: Repositories;
  llm?: LlmProvider;
  embeddings?: EmbeddingProvider | null;
  graph?: GraphClient;
  notifier?: Notifier;
  logger?: Logger;
  metrics?: Metrics;
  /** Skip the queue/circuit wrapper (unit tests that assert on the raw provider). */
  skipLlmQueue?: boolean;
}

/** Composition root: builds adapters from the config (or the given overrides) and wires the services. */
export async function createContainer(cfg: Config, overrides: ContainerOverrides = {}): Promise<Container> {
  const logger = overrides.logger ?? { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  const metrics = overrides.metrics ?? new Metrics({ defaultMetrics: cfg.NODE_ENV !== "test", version: APP_VERSION, role: cfg.ROLE });

  /* ------------------------------ database ------------------------------ */
  let repos = overrides.repos;
  let pool: PgPool | undefined;
  let vectorStore: VectorStoreState | undefined;
  if (!repos) {
    if (isMemoryDatabase(cfg)) {
      repos = createMemoryRepositories();
      logger.info({}, "using in-memory repositories (DATABASE_URL=memory)");
    } else {
      pool = createPool(cfg.DATABASE_URL, {
        max: cfg.DB_POOL_MAX,
        min: cfg.DB_POOL_MIN,
        statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS,
        idleTimeoutMs: cfg.DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMs: cfg.DB_CONNECTION_TIMEOUT_MS,
        applicationName: `oao-orchestrator-${cfg.ROLE}`,
        logger,
      });
      if (cfg.DB_AUTO_MIGRATE) {
        const applied = await runMigrations(pool, { embeddingDimensions: cfg.EMBEDDING_DIMENSIONS, logger });
        logger.info({ applied }, "database migrations checked");
      }
      /*
       * Vector dimension guard — runs on every boot, migrations or not.
       *
       * With DB_AUTO_MIGRATE the column is re-dimensioned in place (stored
       * embeddings discarded, WARN logged). Without it, nothing is touched and
       * `ready()` below reports the mismatch so /ready answers 503 with the
       * exact remediation instead of every indexing request failing with a
       * pgvector "expected N dimensions" error.
       */
      vectorStore = await ensureVectorDimensions(pool, {
        configuredDimensions: cfg.EMBEDDING_DIMENSIONS,
        autoMigrate: cfg.DB_AUTO_MIGRATE,
        embeddingModel: cfg.LLM_PROVIDER === "mock" ? undefined : cfg.EMBEDDING_MODEL,
        logger,
      });
      repos = createPgRepositories(pool, { embeddingDimensions: cfg.EMBEDDING_DIMENSIONS });
    }
  }

  /* -------------------------------- model ------------------------------- */
  let baseLlm = overrides.llm;
  let embeddings = overrides.embeddings === null ? undefined : overrides.embeddings;
  if (!baseLlm) {
    if (cfg.LLM_PROVIDER === "mock") {
      baseLlm = new MockLlmProvider();
      // The dimension must match `EMBEDDING_DIMENSIONS`: the pgvector column is
      // declared `vector(EMBEDDING_DIMENSIONS)` and rejects anything else.
      embeddings ??= cfg.EMBEDDINGS_ENABLED ? new MockEmbeddingProvider(cfg.EMBEDDING_DIMENSIONS) : undefined;
    } else {
      const provider = new OpenAiCompatibleProvider({
        baseUrl: cfg.LLM_BASE_URL,
        apiKey: cfg.LLM_API_KEY,
        model: cfg.LLM_MODEL,
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        maxTokens: cfg.LLM_MAX_TOKENS,
        jsonMode: cfg.LLM_JSON_MODE,
        embeddingModel: cfg.EMBEDDING_MODEL,
        embeddingDimensions: cfg.EMBEDDING_DIMENSIONS,
        embeddingBatchSize: cfg.EMBEDDING_BATCH_SIZE,
        logger,
      });
      baseLlm = provider;
      embeddings ??= cfg.EMBEDDINGS_ENABLED ? provider : undefined;
    }
  }

  // Queue + two-tier routing + circuit breaker in front of the provider.
  const llmQueue = overrides.skipLlmQueue
    ? undefined
    : new QueuedLlmProvider(baseLlm, {
        concurrency: cfg.LLM_CONCURRENCY,
        queueTimeoutMs: cfg.LLM_QUEUE_TIMEOUT_MS,
        circuitFailures: cfg.LLM_CIRCUIT_FAILURES,
        circuitCooldownMs: cfg.LLM_CIRCUIT_COOLDOWN_MS,
        model: baseLlm.model,
        fastModel: cfg.LLM_FAST_MODEL,
        logger,
        onCall: (sample) => metrics.observeLlmCall(sample),
      });
  const llm: LlmProvider = llmQueue ?? baseLlm;

  // Embedding cache in front of the embedding provider.
  let embeddingCache: CachedEmbeddingProvider | undefined;
  if (embeddings && cfg.EMBEDDING_CACHE_ENABLED) {
    embeddingCache = new CachedEmbeddingProvider(embeddings, repos.embeddingCache, {
      batchSize: cfg.EMBEDDING_BATCH_SIZE,
      ttlDays: cfg.EMBEDDING_CACHE_TTL_DAYS,
      logger,
      onHit: (n) => metrics.cacheHit("embedding", n),
      onMiss: (n) => metrics.cacheMiss("embedding", n),
    });
    embeddings = embeddingCache;
  }

  /* -------------------------------- graph ------------------------------- */
  const graph =
    overrides.graph ??
    (cfg.GRAPH_ENABLED
      ? new MsalGraphClient({ tenantId: cfg.AAD_TENANT_ID!, clientId: cfg.AAD_CLIENT_ID!, clientSecret: cfg.AAD_CLIENT_SECRET!, authMode: cfg.GRAPH_AUTH_MODE, logger })
      : new DisabledGraphClient());
  const notifier = overrides.notifier ?? new WebhookNotifier(cfg.NOTIFY_WEBHOOK_URL, fetch, logger);

  const deps: ServiceDeps = { cfg, repos, llm, embeddings, graph, notifier, logger, metrics };
  const services = createServices(deps, metrics);

  const capturedPool = pool;
  const capturedVectorStore = vectorStore;
  return {
    cfg,
    deps,
    services,
    metrics,
    llmQueue,
    embeddingCache,
    pool: capturedPool,
    vectorStore: capturedVectorStore,
    startedAt: Date.now(),
    /**
     * Readiness: the database must be reachable **and** migrated. An LLM or
     * Graph outage is explicitly *not* a readiness failure — the service still
     * answers with heuristics, and taking the pod out of the Service would
     * only turn a degradation into an outage.
     */
    ready: async () => {
      const db = await repos!.ping(2000);
      if (!db.ok) return { ok: false, detail: `database: ${db.detail}` };
      if (!capturedPool) return { ok: true, detail: "in-memory repositories" };
      try {
        const m = await migrationsUpToDate(capturedPool);
        if (!m.ok) return { ok: false, detail: `migrations pending: ${m.missing.join(", ")}` };
      } catch (e) {
        return { ok: false, detail: `migrations: ${(e as Error).message}` };
      }
      // A vector column that disagrees with EMBEDDING_DIMENSIONS is a
      // configuration error an operator must resolve: every embedding write
      // would fail. Lexical-only (no pgvector at all) is a *supported* mode and
      // stays ready.
      if (capturedVectorStore?.mismatch) return { ok: false, detail: capturedVectorStore.mismatch };
      return { ok: true, detail: `database reachable, migrations applied${capturedVectorStore ? `, ${capturedVectorStore.detail}` : ""}` };
    },
    close: async () => {
      await repos!.close();
    },
  };
}

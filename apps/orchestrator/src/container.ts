import type { Config } from "./config.js";
import { isMemoryDatabase } from "./config.js";
import { createPgRepositories } from "./adapters/db/index.js";
import { runMigrations } from "./adapters/db/migrate.js";
import { createPool } from "./adapters/db/pool.js";
import { DisabledGraphClient, MsalGraphClient } from "./adapters/graph/client.js";
import { MockEmbeddingProvider, MockLlmProvider } from "./adapters/llm/mock.js";
import { OpenAiCompatibleProvider } from "./adapters/llm/openai-compatible.js";
import { createMemoryRepositories } from "./adapters/memory/index.js";
import { WebhookNotifier } from "./adapters/notify/webhook.js";
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
  close(): Promise<void>;
}

export interface ContainerOverrides {
  repos?: Repositories;
  llm?: LlmProvider;
  embeddings?: EmbeddingProvider | null;
  graph?: GraphClient;
  notifier?: Notifier;
  logger?: Logger;
}

/** Composition root: builds adapters from the config (or the given overrides) and wires the services. */
export async function createContainer(cfg: Config, overrides: ContainerOverrides = {}): Promise<Container> {
  const logger = overrides.logger ?? { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

  let repos = overrides.repos;
  if (!repos) {
    if (isMemoryDatabase(cfg)) {
      repos = createMemoryRepositories();
      logger.info({}, "using in-memory repositories (DATABASE_URL=memory)");
    } else {
      const pool = createPool(cfg.DATABASE_URL);
      if (cfg.DB_AUTO_MIGRATE) {
        const applied = await runMigrations(pool, { embeddingDimensions: cfg.EMBEDDING_DIMENSIONS, logger });
        logger.info({ applied }, "database migrations checked");
      }
      repos = createPgRepositories(pool);
    }
  }

  let llm = overrides.llm;
  let embeddings = overrides.embeddings === null ? undefined : overrides.embeddings;
  if (!llm) {
    if (cfg.LLM_PROVIDER === "mock") {
      llm = new MockLlmProvider();
      embeddings ??= cfg.EMBEDDINGS_ENABLED ? new MockEmbeddingProvider(Math.min(cfg.EMBEDDING_DIMENSIONS, 256)) : undefined;
    } else {
      const provider = new OpenAiCompatibleProvider({ baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, model: cfg.LLM_MODEL, timeoutMs: cfg.LLM_TIMEOUT_MS, maxTokens: cfg.LLM_MAX_TOKENS, jsonMode: cfg.LLM_JSON_MODE, embeddingModel: cfg.EMBEDDING_MODEL, embeddingDimensions: cfg.EMBEDDING_DIMENSIONS, logger });
      llm = provider;
      embeddings ??= cfg.EMBEDDINGS_ENABLED ? provider : undefined;
    }
  }

  const graph = overrides.graph ?? (cfg.GRAPH_ENABLED ? new MsalGraphClient({ tenantId: cfg.AAD_TENANT_ID!, clientId: cfg.AAD_CLIENT_ID!, clientSecret: cfg.AAD_CLIENT_SECRET! }) : new DisabledGraphClient());
  const notifier = overrides.notifier ?? new WebhookNotifier(cfg.NOTIFY_WEBHOOK_URL, fetch, logger);

  const deps: ServiceDeps = { cfg, repos, llm, embeddings, graph, notifier, logger };
  const services = createServices(deps);
  return { cfg, deps, services, close: () => repos!.close() };
}

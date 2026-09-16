import type { Language } from "@oao/shared";
import type { Config } from "../config.js";
import type { AuthenticatedUser } from "../auth/identity.js";
import type { Metrics } from "../metrics.js";
import type { EmbeddingProvider, LlmProvider } from "../ports/llm.js";
import type { GraphClient } from "../ports/graph.js";
import type { Notifier } from "../ports/notifier.js";
import type { Repositories } from "../ports/repositories.js";

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

export const noopLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** Everything a use case may need (composition root wires it once). */
export interface ServiceDeps {
  cfg: Config;
  repos: Repositories;
  llm: LlmProvider;
  embeddings?: EmbeddingProvider;
  graph: GraphClient;
  notifier: Notifier;
  logger: Logger;
  /** Prometheus registry (optional so unit tests can wire a bare deps object). */
  metrics?: Metrics;
}

/** Per-request context passed by the controllers. */
export interface RequestContext {
  user: AuthenticatedUser;
  language: Language;
  correlationId?: string;
}

import type { z } from "zod";

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/**
 * Hint used by the deterministic mock provider (ignored by real providers) and
 * by the two-tier model router (`adapters/llm/queue.ts`): the `*_FAST` use cases
 * are served by `LLM_FAST_MODEL` when one is configured.
 */
export type LlmUseCase =
  | "email_analysis"
  /** Reduced analysis prompt used when the decision engine already classified the email (no classification asked). */
  | "email_narrative"
  | "thread_synthesis"
  | "draft_reply"
  | "chat_answer"
  | "daily_brief"
  | "classification"
  | "compliance_content"
  | "phishing_content"
  | "triage_assist"
  | "extraction"
  | "generic";

/** Queue lane: interactive requests always overtake background precomputation. */
export type LlmPriority = "interactive" | "background";

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object (response_format / prompt instruction). */
  json?: boolean;
  useCase?: LlmUseCase;
  language?: "fr" | "en";
  /** Explicit model override; otherwise the router picks fast vs main by use case. */
  model?: string;
  /** Scheduling lane (default `interactive`). */
  priority?: LlmPriority;
  /** Used for per-user fairness in the queue (round-robin between users). */
  userId?: string;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmCompletion {
  text: string;
  usage?: LlmUsage;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmCompletion>;
  /**
   * Complete and parse the answer as JSON validated with `schema`.
   * Implementations must try one repair round before throwing an `LlmError("output")`.
   */
  completeJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: LlmRequest): Promise<{ data: T; model: string; repaired: boolean; raw: string }>;
  /** Cheap liveness probe (used by /health). */
  ping(timeoutMs: number): Promise<{ ok: boolean; detail?: string }>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

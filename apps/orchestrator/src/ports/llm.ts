import type { z } from "zod";

export type LlmRole = "system" | "user" | "assistant";

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/** Hint used by the deterministic mock provider (ignored by real providers). */
export type LlmUseCase =
  | "email_analysis"
  | "thread_synthesis"
  | "draft_reply"
  | "chat_answer"
  | "classification"
  | "compliance_content"
  | "generic";

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object (response_format / prompt instruction). */
  json?: boolean;
  useCase?: LlmUseCase;
  language?: "fr" | "en";
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

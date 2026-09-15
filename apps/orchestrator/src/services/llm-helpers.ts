import type { z } from "zod";
import type { LlmProvider, LlmRequest } from "../ports/llm.js";
import { LlmError } from "../errors.js";
import type { Logger } from "./context.js";

export interface StructuredResult<T> {
  data: T;
  model: string;
  latencyMs: number;
  repaired: boolean;
  promptText: string;
  raw: string;
  /** True when the model was unavailable / unusable and `data` came from `fallback`. */
  degraded: boolean;
  error?: string;
}

/** Structured completion with timing and heuristic fallback (confidence ≤ 0.3 handled by the caller). */
export async function completeStructured<T>(llm: LlmProvider, schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: LlmRequest, fallback: () => T, logger: Logger): Promise<StructuredResult<T>> {
  const started = Date.now();
  const promptText = req.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  try {
    const r = await llm.completeJson(schema, req);
    return { data: r.data, model: r.model, latencyMs: Date.now() - started, repaired: r.repaired, promptText, raw: r.raw, degraded: false };
  } catch (e) {
    const error = e instanceof LlmError ? `${e.kind}: ${e.message}` : (e as Error).message;
    logger.warn({ useCase: req.useCase, error }, "llm unavailable or invalid output, using heuristic fallback");
    return { data: fallback(), model: `${llm.model} (degraded)`, latencyMs: Date.now() - started, repaired: false, promptText, raw: "", degraded: true, error };
  }
}

export const DEGRADED_CONFIDENCE = 0.3;

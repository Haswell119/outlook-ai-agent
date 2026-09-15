import type { z } from "zod";
import type { EmbeddingProvider, LlmCompletion, LlmProvider, LlmRequest } from "../../ports/llm.js";
import { LlmError } from "../../errors.js";
import { extractJson } from "./json.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  jsonMode: "auto" | "response_format" | "prompt";
  embeddingModel: string;
  embeddingDimensions: number;
  /** Retries on 429 / 5xx / network errors (default 2). */
  maxRetries?: number;
  /** Base backoff delay in ms (default 500). */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void };
}

type Logger = NonNullable<OpenAiCompatibleOptions["logger"]>;
const silent: Logger = { warn: () => undefined, debug: () => undefined };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client for any OpenAI-compatible server (vLLM, Ollama, LM Studio, TGI, Azure OpenAI…).
 * Only `fetch` — no SDK. Handles JSON mode negotiation, timeouts, retries and
 * the JSON validate → repair → fail pipeline.
 */
export class OpenAiCompatibleProvider implements LlmProvider, EmbeddingProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  readonly dimensions: number;
  private readonly opts: OpenAiCompatibleOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private responseFormatSupported: boolean | undefined;

  constructor(opts: OpenAiCompatibleOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.dimensions = opts.embeddingDimensions;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? silent;
  }

  get embeddingModel(): string {
    return this.opts.embeddingModel;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** POST with timeout + retries; returns the parsed JSON body. */
  private async post(path: string, body: unknown, attempt = 0): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? 2;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      const isTimeout = (e as Error).name === "AbortError";
      if (attempt < maxRetries) {
        this.log.warn({ attempt, path, err: (e as Error).message }, "llm request failed, retrying");
        await sleep((this.opts.retryDelayMs ?? 500) * Math.pow(3, attempt));
        return this.post(path, body, attempt + 1);
      }
      throw new LlmError(isTimeout ? "timeout" : "network", isTimeout ? `LLM request timed out after ${this.opts.timeoutMs} ms` : `LLM request failed: ${(e as Error).message}`);
    }
    clearTimeout(timer);
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new LlmError("output", "LLM returned a non-JSON HTTP body");
      }
    }
    const text = await res.text().catch(() => "");
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (this.opts.retryDelayMs ?? 500) * Math.pow(3, attempt);
      this.log.warn({ attempt, status: res.status, path }, "llm http error, retrying");
      await sleep(delay);
      return this.post(path, body, attempt + 1);
    }
    throw new LlmError("http", `LLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const wantJson = req.json === true;
    const useResponseFormat = wantJson && this.opts.jsonMode !== "prompt" && this.responseFormatSupported !== false;
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    if (wantJson && (this.opts.jsonMode === "prompt" || !useResponseFormat)) {
      const last = messages[messages.length - 1];
      if (last) last.content += "\n\nRespond with a single valid JSON object and nothing else.";
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? this.opts.maxTokens,
    };
    if (useResponseFormat) body.response_format = { type: "json_object" };

    let data: unknown;
    try {
      data = await this.post("/chat/completions", body);
    } catch (e) {
      // `auto` mode: a 400 usually means response_format is not supported → fall back to prompt mode once.
      if (e instanceof LlmError && e.kind === "http" && e.status === 400 && useResponseFormat && this.opts.jsonMode === "auto") {
        this.log.warn({}, "response_format rejected by the server, falling back to prompt JSON mode");
        this.responseFormatSupported = false;
        return this.complete(req);
      }
      throw e;
    }
    const d = data as { choices?: Array<{ message?: { content?: string | null; reasoning_content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; model?: string };
    const text = d.choices?.[0]?.message?.content ?? "";
    if (!text) throw new LlmError("output", "LLM returned an empty completion");
    return {
      text,
      model: d.model ?? this.model,
      usage: d.usage ? { promptTokens: d.usage.prompt_tokens, completionTokens: d.usage.completion_tokens, totalTokens: d.usage.total_tokens } : undefined,
    };
  }

  async completeJson<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: LlmRequest): Promise<{ data: T; model: string; repaired: boolean; raw: string }> {
    const first = await this.complete({ ...req, json: true });
    const attempt = tryParse(schema, first.text);
    if (attempt.ok) return { data: attempt.data, model: first.model, repaired: false, raw: first.text };
    this.log.warn({ error: attempt.error }, "llm json did not validate, asking the model to repair it");
    const repair = await this.complete({
      ...req,
      json: true,
      temperature: 0,
      messages: [
        ...req.messages,
        { role: "assistant", content: first.text.slice(0, 8000) },
        { role: "user", content: `Fix this JSON to match the schema described above. Problems: ${attempt.error.slice(0, 800)}. Return only the corrected JSON object.` },
      ],
    });
    const second = tryParse(schema, repair.text);
    if (second.ok) return { data: second.data, model: repair.model, repaired: true, raw: repair.text };
    throw new LlmError("output", `LLM output did not match the schema after repair: ${second.error.slice(0, 300)}`);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const data = (await this.post("/embeddings", { model: this.opts.embeddingModel, input: texts })) as { data?: Array<{ index?: number; embedding: number[] }> };
    const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== texts.length) throw new LlmError("output", `Embedding endpoint returned ${rows.length} vectors for ${texts.length} inputs`);
    return rows.map((r) => r.embedding);
  }

  async ping(timeoutMs: number): Promise<{ ok: boolean; detail?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url("/models"), { headers: this.headers(), signal: controller.signal });
      return res.ok ? { ok: true, detail: `${this.opts.baseUrl} reachable` } : { ok: false, detail: `HTTP ${res.status} from ${this.opts.baseUrl}/models` };
    } catch (e) {
      return { ok: false, detail: (e as Error).name === "AbortError" ? `timeout after ${timeoutMs} ms` : (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function tryParse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string): { ok: true; data: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ") };
}

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { extractJson, firstBalancedObject, stripCodeFences, stripThinkBlocks } from "../../src/adapters/llm/json.js";
import { OpenAiCompatibleProvider } from "../../src/adapters/llm/openai-compatible.js";
import { MockEmbeddingProvider, MockLlmProvider, parseEmailBlock } from "../../src/adapters/llm/mock.js";
import { LlmError } from "../../src/errors.js";
import { buildEmailAnalysisPrompt, EmailAnalysisLlmSchema, formatEmail } from "../../src/domain/prompts/index.js";
import { sampleEmail } from "../helpers.js";

describe("json extraction", () => {
  it("strips <think> blocks (closed and unclosed) and code fences", () => {
    expect(stripThinkBlocks("<think>reasoning\nmore</think>\n{\"a\":1}")).toBe('{"a":1}');
    expect(stripThinkBlocks("<think>never closed {\"x\":2}")).toBe("");
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripCodeFences("```\n{\"a\":1}```")).toBe('{"a":1}');
  });
  it("extracts the first balanced object from surrounding prose, string-aware", () => {
    expect(firstBalancedObject('text { "s": "}" , "n": {"k": 1}} trailing {')).toBe('{ "s": "}" , "n": {"k": 1}}');
    expect(extractJson('Sure! Here is the JSON:\n```json\n{"summary": "x", "n": [1,2,]}\n```\nHope it helps')).toEqual({ summary: "x", n: [1, 2] });
    expect(extractJson('<think>hmm</think>{"a": {"b": "c"}} extra')).toEqual({ a: { b: "c" } });
    expect(() => extractJson("no json here")).toThrow(/No JSON/);
  });
});

function fakeFetch(handler: (url: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  let call = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}, call++));
  return fn as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}
const completion = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content } }], model: "qwen-test", usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status, headers: { "content-type": "application/json" } });
const opts = (fetchImpl: typeof fetch, jsonMode: "auto" | "response_format" | "prompt" = "auto") => ({ baseUrl: "http://llm.local/v1/", apiKey: "k", model: "qwen", timeoutMs: 500, maxTokens: 100, jsonMode, embeddingModel: "bge", embeddingDimensions: 4, retryDelayMs: 1, fetchImpl });
const schema = z.object({ answer: z.string(), n: z.number() });

describe("OpenAiCompatibleProvider", () => {
  it("sends response_format in auto mode and falls back to prompt mode on HTTP 400", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = fakeFetch((_u, init, call) => {
      bodies.push(JSON.parse(String(init.body)));
      return call === 0 ? new Response("response_format not supported", { status: 400 }) : completion('{"answer":"hi","n":1}');
    });
    const p = new OpenAiCompatibleProvider(opts(f));
    const r = await p.completeJson(schema, { messages: [{ role: "user", content: "q" }], json: true });
    expect(r.data).toEqual({ answer: "hi", n: 1 });
    expect(bodies[0]!.response_format).toEqual({ type: "json_object" });
    expect(bodies[1]!.response_format).toBeUndefined();
    expect(String((bodies[1]!.messages as Array<{ content: string }>)[0]!.content)).toContain("JSON");
    // Fallback is remembered.
    await p.complete({ messages: [{ role: "user", content: "q" }], json: true });
    expect(bodies[2]!.response_format).toBeUndefined();
    expect(String(f.mock.calls[0]![0])).toBe("http://llm.local/v1/chat/completions");
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer k" });
  });

  it("retries on 429/5xx and network errors, then throws LlmError", async () => {
    const f = fakeFetch((_u, _i, call) => (call === 0 ? new Response("busy", { status: 503 }) : call === 1 ? Promise.reject(new Error("ECONNRESET")) : completion('{"answer":"ok","n":2}')));
    const p = new OpenAiCompatibleProvider(opts(f));
    expect((await p.complete({ messages: [{ role: "user", content: "q" }] })).text).toContain("ok");
    const always = fakeFetch(() => new Response("down", { status: 500 }));
    await expect(new OpenAiCompatibleProvider(opts(always)).complete({ messages: [{ role: "user", content: "q" }] })).rejects.toBeInstanceOf(LlmError);
    expect(always.mock.calls.length).toBe(3);
  });

  it("times out via AbortController", async () => {
    const f = fakeFetch((_u, init) => new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    const p = new OpenAiCompatibleProvider({ ...opts(f), timeoutMs: 20, maxRetries: 0 });
    await expect(p.complete({ messages: [{ role: "user", content: "q" }] })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("repairs invalid JSON once, then fails with an output error", async () => {
    const f = fakeFetch((_u, _i, call) => (call === 0 ? completion('<think>let me think</think>```json\n{"answer": "x", "n": "NaN"}\n```') : completion('{"answer":"x","n":3}')));
    const p = new OpenAiCompatibleProvider(opts(f));
    const r = await p.completeJson(schema, { messages: [{ role: "user", content: "q" }] });
    expect(r).toMatchObject({ data: { answer: "x", n: 3 }, repaired: true });
    const bad = fakeFetch(() => completion("garbage"));
    await expect(new OpenAiCompatibleProvider(opts(bad)).completeJson(schema, { messages: [{ role: "user", content: "q" }] })).rejects.toMatchObject({ kind: "output" });
    expect(bad.mock.calls.length).toBe(2);
  });

  it("embeds and pings", async () => {
    const f = fakeFetch((u) => (u.endsWith("/embeddings") ? new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })) : new Response("{}", { status: 200 })));
    const p = new OpenAiCompatibleProvider(opts(f));
    expect(await p.embed(["a", "b"])).toEqual([[1, 0], [0, 1]]);
    expect((await p.ping(100)).ok).toBe(true);
    expect((await new OpenAiCompatibleProvider(opts(fakeFetch(() => new Response("x", { status: 500 })))).ping(100)).ok).toBe(false);
  });
});

describe("MockLlmProvider", () => {
  it("parses the email block back and produces schema-valid analysis JSON", async () => {
    const email = sampleEmail();
    const parsed = parseEmailBlock(formatEmail(email));
    expect(parsed.subject).toBe(email.subject);
    expect(parsed.from?.address).toBe("sarah.johnson@vendorco.com");
    expect(parsed.attachments.map((a) => a.name)).toEqual(["Q2 Vendor Risk Assessment.pdf"]);
    expect(parsed.body).toContain("high-risk findings");
    const mock = new MockLlmProvider();
    const r = await mock.completeJson(EmailAnalysisLlmSchema, buildEmailAnalysisPrompt(email, "en").request);
    expect(r.data.summary).toContain("Sarah Johnson");
    expect(r.data.suggestedActions.map((a) => a.type)).toContain("create_reminder");
    expect(r.data.risks.map((x) => x.code)).toContain("confidential_content");
    expect(r.data.confidence).toBeGreaterThan(0.7);
  });
  it("test hooks: nextRawResponse and failing", async () => {
    const mock = new MockLlmProvider();
    mock.nextRawResponse = '{"answer":"raw","n":1}';
    expect((await mock.completeJson(schema, { messages: [] })).data.answer).toBe("raw");
    mock.failing = true;
    await expect(mock.complete({ messages: [] })).rejects.toBeInstanceOf(LlmError);
    expect((await mock.ping()).ok).toBe(false);
  });
  it("mock embeddings are deterministic, normalised and similar for similar text", async () => {
    const e = new MockEmbeddingProvider(32);
    const [a, b, c] = await e.embed(["mandate approval client", "client mandate approved", "lunch tomorrow"]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    expect(dot(a!, a!)).toBeCloseTo(1, 5);
    expect(dot(a!, b!)).toBeGreaterThan(dot(a!, c!));
  });
});

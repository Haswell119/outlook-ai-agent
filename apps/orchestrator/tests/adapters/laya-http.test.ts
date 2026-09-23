import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LayaHttpDecisionProvider, type LayaHttpOptions } from "../../src/adapters/decision/laya-http.js";
import { DecisionProviderError, type DecisionProviderRequest } from "../../src/ports/decision.js";

/**
 * `LayaHttpDecisionProvider` against the `laya-serve` wire contract
 * (`POST /v1/systemone`, `GET /health`), with a scripted `fetch` for the
 * status / shape cases and a real local HTTP server for streaming and timeouts.
 */

const SECRET_BODY = "CANARY-BODY-7f3a Le fichier NAV ne pourra pas être livré";
const API_KEY = "laya-test-key-3b9d";

const request = (over: Partial<DecisionProviderRequest> = {}): DecisionProviderRequest => ({
  state: { language: "fr", subject: "Import NAV bloqué", body: SECRET_BODY },
  questions: {
    urgency: { type: "choice", instructions: "Détermine le niveau d'urgence métier du message.", criteria: { low: "informatif", normal: "action attendue", high: "échéance proche", critical: "incident de production" } },
    replyExpected: { type: "choice", instructions: "Détermine si une réponse est attendue.", criteria: { required: "réponse attendue", not_required: "information seulement" } },
  },
  model: "multilingual",
  ...over,
});

/** A laya-serve 0.3.x answer (Jev-shaped) for `request()`. */
const layaAnswer = (over: Record<string, unknown> = {}) => ({
  model: "laya-rl-agent",
  answers: {
    urgency: { type: "choice", choice: "high", probabilities: { low: 0.02, normal: 0.08, high: 0.85, critical: 0.05 }, confidence: 0.6123, action: { act_probability: 1.0 } },
    replyExpected: { type: "choice", choice: "required", probabilities: { required: 0.97, not_required: 0.03 }, confidence: 0.8055, action: { act_probability: 0.99 } },
  },
  usage: { input_tokens: 312, output_tokens: 0 },
  routing: { model: "multilingual", repo: "convaiinnovations/laya/multilingual", reason: "explicit model='multilingual'", detection: null, workflow: null },
  ...over,
});

interface Captured {
  url: string;
  init: RequestInit;
}

/** `fetch` double: records calls, answers with the scripted Response (or throws). */
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function logs() {
  const lines: Array<{ level: string; obj: unknown; msg?: string }> = [];
  return {
    lines,
    logger: {
      warn: (obj: unknown, msg?: string) => lines.push({ level: "warn", obj, msg }),
      debug: (obj: unknown, msg?: string) => lines.push({ level: "debug", obj, msg }),
    },
  };
}

const provider = (fetchImpl: typeof fetch, over: Partial<LayaHttpOptions> = {}) =>
  new LayaHttpDecisionProvider({ baseUrl: "http://laya.test:8000/", apiKey: API_KEY, timeoutMs: 2_000, maxResponseBytes: 64 * 1024, fetchImpl, ...over });

async function failure(p: Promise<unknown>): Promise<DecisionProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DecisionProviderError);
    return e as DecisionProviderError;
  }
  throw new Error("expected a DecisionProviderError");
}

describe("LayaHttpDecisionProvider — request", () => {
  it("POSTs { state, questions, model } as JSON to /v1/systemone with the bearer token", async () => {
    const f = fakeFetch(() => json(layaAnswer()));
    await provider(f.impl).evaluate(request(), { correlationId: "corr-1" });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("http://laya.test:8000/v1/systemone");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers["x-correlation-id"]).toBe("corr-1");
    expect(init.redirect).toBe("error");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ state: request().state, questions: request().questions, model: "multilingual" });
  });

  it("sends no Authorization header when no key is configured, and no `model` field for auto routing", async () => {
    const f = fakeFetch(() => json(layaAnswer()));
    await provider(f.impl, { apiKey: undefined }).evaluate(request({ model: undefined }));
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty("model");
  });

  it("validates the internal request before sending anything", async () => {
    const f = fakeFetch(() => json(layaAnswer()));
    const p = provider(f.impl);
    const oneOption = request({ questions: { urgency: { type: "choice", instructions: "x", criteria: { low: "only" } } } });
    expect((await failure(p.evaluate(oneOption))).kind).toBe("invalid_request");
    const badId = request({ questions: { urgency: { type: "choice", instructions: "x", criteria: { "Not An Id": "a", b: "b" } } } });
    expect((await failure(p.evaluate(badId))).kind).toBe("invalid_request");
    const badModel = request({ model: "../../etc/passwd;rm" });
    expect((await failure(p.evaluate(badModel))).kind).toBe("invalid_request");
    const noQuestion = request({ questions: {} });
    expect((await failure(p.evaluate(noQuestion))).kind).toBe("invalid_request");
    expect(f.calls).toHaveLength(0);
  });
});

describe("LayaHttpDecisionProvider — response mapping", () => {
  it("maps choices, probabilities, confidence, routing and usage", async () => {
    const f = fakeFetch(() => json(layaAnswer()));
    const r = await provider(f.impl).evaluate(request());
    expect(r.answers.urgency).toEqual({ type: "choice", choice: "high", probabilities: { low: 0.02, normal: 0.08, high: 0.85, critical: 0.05 }, confidence: 0.6123 });
    expect(r.answers.replyExpected).toMatchObject({ choice: "required", confidence: 0.8055 });
    expect(r.answers.replyExpected?.probabilities.required).toBe(0.97);
    expect(r.model).toBe("multilingual"); // routing.model wins over the generic agent name
    expect(r.routing).toEqual({ model: "multilingual", reason: "explicit model='multilingual'" });
    expect(r.usage).toEqual({ inputTokens: 312, outputTokens: 0 });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("tolerates unknown fields (passthrough) and ignores unasked questions and other primitives", async () => {
    const body = layaAnswer({
      server_version: "0.3.9",
      answers: {
        ...layaAnswer().answers,
        urgency: { ...layaAnswer().answers.urgency, calibration: { bucket: "choice:3-5" } },
        extra_question: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 },
        future: { type: "score", score: 1.2, legend: {}, probabilities: {}, confidence: 0.4 },
      },
      routing: { model: "multilingual", reason: "r", new_field: [1, 2] },
      usage: { input_tokens: 1, output_tokens: 0, cached_tokens: 0 },
    });
    const r = await provider(fakeFetch(() => json(body)).impl).evaluate(request());
    expect(Object.keys(r.answers).sort()).toEqual(["replyExpected", "urgency"]);
  });

  it("an answer without confidence is kept, without confidence (the policy will refuse it)", async () => {
    const body = layaAnswer({ answers: { urgency: { type: "choice", choice: "low", probabilities: { low: 0.7, normal: 0.1, high: 0.1, critical: 0.1 } } } });
    const r = await provider(fakeFetch(() => json(body)).impl).evaluate(request());
    expect(r.answers.urgency?.confidence).toBeUndefined();
    expect(r.answers.urgency?.choice).toBe("low");
  });

  it.each([
    ["non-JSON body", () => new Response("<html>502 Bad Gateway</html>", { status: 200 })],
    ["answers missing", () => json({ model: "x" })],
    ["no answer at all", () => json({ answers: {} })],
    ["probability > 1", () => json(layaAnswer({ answers: { urgency: { type: "choice", choice: "high", probabilities: { high: 1.4 }, confidence: 0.9 } } }))],
    ["probabilities not summing to 1", () => json(layaAnswer({ answers: { urgency: { type: "choice", choice: "high", probabilities: { low: 0.4, high: 0.2 }, confidence: 0.9 } } }))],
    ["chosen option without probability", () => json(layaAnswer({ answers: { urgency: { type: "choice", choice: "high", probabilities: { low: 1 }, confidence: 0.9 } } }))],
    ["confidence not a number", () => json(layaAnswer({ answers: { urgency: { type: "choice", choice: "high", probabilities: { high: 1 }, confidence: "high" } } }))],
    ["empty choice", () => json(layaAnswer({ answers: { urgency: { type: "choice", choice: "", probabilities: {}, confidence: 0.9 } } }))],
  ])("invalid response (%s) → invalid_response, counted as a failure", async (_label, respond) => {
    const e = await failure(provider(fakeFetch(respond).impl).evaluate(request()));
    expect(e.kind).toBe("invalid_response");
    expect(e.countsAsFailure).toBe(true);
  });
});

describe("LayaHttpDecisionProvider — errors", () => {
  it.each([
    [401, "unauthorized", true],
    [403, "unauthorized", true],
    [400, "invalid_request", false],
    // laya-serve answers 422 when running the model raised (e.g. checkpoint missing offline).
    [422, "model_error", true],
    [429, "rate_limited", true],
    [500, "server", true],
    [503, "server", true],
    [404, "http", true],
  ] as const)("HTTP %i → %s (circuit: %s)", async (status, kind, counts) => {
    const f = fakeFetch(() => json({ detail: `question 'urgency': ${SECRET_BODY}` }, status));
    const e = await failure(provider(f.impl).evaluate(request()));
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
    expect(e.countsAsFailure).toBe(counts);
    // The error body is never quoted: it could echo the request.
    expect(e.message).not.toContain("CANARY");
  });

  it("network error → network (with a content-free cause code)", async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const e = await failure(provider(f.impl).evaluate(request()));
    expect(e.kind).toBe("network");
    expect(e.message).toContain("ECONNREFUSED");
    expect(e.countsAsFailure).toBe(true);
  });

  it("timeout → timeout, bounded by timeoutMs", async () => {
    const f = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const started = Date.now();
    const e = await failure(provider(f.impl, { timeoutMs: 40 }).evaluate(request()));
    expect(e.kind).toBe("timeout");
    expect(e.countsAsFailure).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the caller's AbortSignal cancels the call → aborted, not counted as a provider failure", async () => {
    const f = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const controller = new AbortController();
    const pending = provider(f.impl).evaluate(request(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const e = await failure(pending);
    expect(e.kind).toBe("aborted");
    expect(e.countsAsFailure).toBe(false);
    // Already aborted: nothing is sent.
    const before = f.calls.length;
    expect((await failure(provider(f.impl).evaluate(request(), { signal: controller.signal }))).kind).toBe("aborted");
    expect(f.calls.length).toBe(before);
  });

  it("a declared Content-Length over the limit → response_too_large without reading the body", async () => {
    const f = fakeFetch(() => json(layaAnswer(), 200, { "content-length": String(10 * 1024 * 1024) }));
    const e = await failure(provider(f.impl, { maxResponseBytes: 1024 }).evaluate(request()));
    expect(e.kind).toBe("response_too_large");
    expect(e.countsAsFailure).toBe(true);
  });
});

describe("LayaHttpDecisionProvider — logging", () => {
  it("never logs the state, the questions, the error body or the API key", async () => {
    const l = logs();
    const ok = provider(fakeFetch(() => json(layaAnswer())).impl, { logger: l.logger });
    await ok.evaluate(request(), { correlationId: "corr-9" });
    for (const status of [401, 422, 500]) {
      await ok.evaluate(request()).catch(() => undefined);
      await provider(fakeFetch(() => json({ detail: SECRET_BODY }, status)).impl, { logger: l.logger }).evaluate(request(), { correlationId: "corr-9" }).catch(() => undefined);
    }
    await provider(fakeFetch(() => new Response("not json")).impl, { logger: l.logger }).evaluate(request()).catch(() => undefined);
    const dump = JSON.stringify(l.lines);
    expect(l.lines.length).toBeGreaterThan(3);
    expect(dump).not.toContain("CANARY");
    expect(dump).not.toContain("Import NAV");
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain("Détermine");
    // What is logged: the class of failure, the status and the correlation id.
    expect(l.lines.some((x) => (x.obj as { kind?: string }).kind === "unauthorized" && (x.obj as { correlationId?: string }).correlationId === "corr-9")).toBe(true);
  });
});

describe("LayaHttpDecisionProvider — health", () => {
  it("reports the loaded checkpoints and device, without sending the API key", async () => {
    const f = fakeFetch(() => json({ status: "ok", loaded: ["english", "multilingual"], device: "cpu" }));
    const h = await provider(f.impl).healthCheck();
    expect(h).toMatchObject({ status: "ok", loadedModels: ["english", "multilingual"], device: "cpu" });
    expect(f.calls[0]!.url).toBe("http://laya.test:8000/health");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("lazy server (nothing loaded) is ok; HTTP errors and network errors are unavailable; never throws", async () => {
    expect((await provider(fakeFetch(() => json({ status: "ok", loaded: [] })).impl).healthCheck()).status).toBe("ok");
    expect((await provider(fakeFetch(() => json({ status: "starting" })).impl).healthCheck()).status).toBe("degraded");
    expect((await provider(fakeFetch(() => json({}, 500)).impl).healthCheck()).status).toBe("unavailable");
    const down = await provider(
      fakeFetch(() => {
        throw new TypeError("fetch failed");
      }).impl,
    ).healthCheck();
    expect(down).toMatchObject({ status: "unavailable", detail: "network" });
  });
});

/* -------------------------------------------------------------------------- */
/*  Real HTTP server: streaming size cap, slow body, bearer check              */
/* -------------------------------------------------------------------------- */

describe("LayaHttpDecisionProvider — against a real HTTP server", () => {
  let server: Server;
  let base = "";
  const seen: Array<{ authorization?: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ authorization: req.headers.authorization, body });
        if (req.url === "/v1/systemone" && req.headers.authorization !== `Bearer ${API_KEY}`) {
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ detail: "invalid or missing bearer token" }));
          return;
        }
        const mode = JSON.parse(body || "{}").state?.mode;
        if (mode === "huge") {
          // Chunked, no Content-Length: the cap must be enforced while streaming.
          res.writeHead(200, { "content-type": "application/json" });
          const chunk = "x".repeat(16 * 1024);
          let sent = 0;
          const pump = () => {
            while (sent < 64 && res.write(chunk)) sent++;
            if (sent < 64) res.once("drain", pump);
            else res.end();
          };
          pump();
          return;
        }
        if (mode === "slow-body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"answers":');
          return; // never finishes: the timeout must cover the body too
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(layaAnswer()));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("round-trips with the bearer token; a wrong key is a 401 → unauthorized", async () => {
    const good = await new LayaHttpDecisionProvider({ baseUrl: base, apiKey: API_KEY, timeoutMs: 2_000, maxResponseBytes: 64 * 1024 }).evaluate(request());
    expect(good.answers.urgency?.choice).toBe("high");
    expect(seen.at(-1)?.authorization).toBe(`Bearer ${API_KEY}`);
    const bad = await failure(new LayaHttpDecisionProvider({ baseUrl: base, apiKey: "wrong", timeoutMs: 2_000, maxResponseBytes: 64 * 1024 }).evaluate(request()));
    expect(bad.kind).toBe("unauthorized");
  });

  it("abandons a chunked body past maxResponseBytes", async () => {
    const e = await failure(new LayaHttpDecisionProvider({ baseUrl: base, apiKey: API_KEY, timeoutMs: 5_000, maxResponseBytes: 100 * 1024 }).evaluate(request({ state: { mode: "huge" } })));
    expect(e.kind).toBe("response_too_large");
  });

  it("the timeout also bounds a body that never ends", async () => {
    const started = Date.now();
    const e = await failure(new LayaHttpDecisionProvider({ baseUrl: base, apiKey: API_KEY, timeoutMs: 150, maxResponseBytes: 64 * 1024 }).evaluate(request({ state: { mode: "slow-body" } })));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an unreachable port is a network error", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const e = await failure(new LayaHttpDecisionProvider({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2_000, maxResponseBytes: 1024 }).evaluate(request()));
    expect(e.kind).toBe("network");
  });
});

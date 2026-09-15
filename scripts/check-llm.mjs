#!/usr/bin/env node
/**
 * `pnpm check:llm` — validates the internal LLM endpoint (Northbridge GPU)
 * directly, without going through the orchestrator.
 *
 * Checks, in order: GET /models, POST /chat/completions, POST /embeddings.
 * Reads LLM_* / EMBEDDING_* from .env (a real environment variable always
 * wins). Uses fetch(): no curl, no bash — same behaviour on every OS.
 *
 * Exit code 0 = usable configuration, 1 = blocking problem.
 */
import { join } from "node:path";

import {
  fail,
  helpIfRequested,
  info,
  loadEnv,
  ok,
  parseArgs,
  preview,
  repoRoot,
  request,
  step,
  warn,
} from "./lib/common.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2), {
  booleans: ["help", "h"],
});

helpIfRequested(
  flags,
  `
Usage: pnpm check:llm [path-to-env-file] [options]

Validates the OpenAI-compatible endpoint configured in .env
(vLLM / TGI / Ollama / private Azure OpenAI):

  1. GET  {LLM_BASE_URL}/models           -> reachability + served model names
  2. POST {LLM_BASE_URL}/chat/completions -> a real completion with LLM_MODEL
  3. POST {LLM_BASE_URL}/embeddings       -> EMBEDDING_MODEL + dimension check

Options:
  --timeout <ms>  per-request timeout (default 30000)
  -h, --help      show this help

Default env file: ./.env
`,
);

const envFile = positionals[0] ? join(process.cwd(), positionals[0]) : join(repoRoot, ".env");
const env = loadEnv(envFile);
const timeoutMs = Number(flags.timeout ?? 30000);

const baseUrl = (env.LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
const model = (env.LLM_MODEL ?? "").trim();
const apiKey = (env.LLM_API_KEY ?? "").trim();
const embeddingModel = (env.EMBEDDING_MODEL ?? "").trim();
const expectedDimensions = Number(env.EMBEDDING_DIMENSIONS ?? 0);
const provider = (env.LLM_PROVIDER ?? "").trim();

if (provider === "mock") {
  warn("LLM_PROVIDER=mock — the orchestrator will not call any endpoint (demo mode).");
  info("Set LLM_PROVIDER=openai-compatible to validate a real endpoint.");
}

if (!baseUrl) {
  fail("LLM_BASE_URL is not set — nothing to check. See docs/SETUP.md.");
  process.exit(1);
}

const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
let failed = false;

/* -- 1. /models ------------------------------------------------------------ */
step(`GET ${baseUrl}/models`);
const models = await request(`${baseUrl}/models`, { headers, timeoutMs });
if (!models.ok) {
  fail(`GET ${baseUrl}/models -> ${models.status || "no response"} ${models.error ?? ""}`);
  info(preview(models.body));
  info("Check the URL/port, that the server is running, and any proxy or NetworkPolicy in between.");
  process.exit(1);
}
ok("/models reachable");
const served = Array.isArray(models.json?.data) ? models.json.data.map((m) => m.id) : [];
info(`served models: ${served.join(", ") || "(empty list)"}`);
if (model && served.length > 0 && !served.includes(model)) {
  warn(`LLM_MODEL="${model}" is not in the served list (check --served-model-name).`);
}

/* -- 2. /chat/completions -------------------------------------------------- */
if (!model) {
  fail("LLM_MODEL is not set — cannot run the completion check.");
  process.exit(1);
}
step(`POST ${baseUrl}/chat/completions (model=${model})`);
const chat = await request(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers,
  timeoutMs,
  body: {
    model,
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    max_tokens: 16,
    temperature: 0,
  },
});
if (!chat.ok) {
  fail(`POST /chat/completions -> ${chat.status || "no response"} ${chat.error ?? ""}`);
  info(preview(chat.body));
  failed = true;
} else {
  const content = chat.json?.choices?.[0]?.message?.content ?? "(no content field)";
  ok("chat completion succeeded");
  info(`model replied: ${preview(JSON.stringify(content), 120)}`);
}

/* -- 3. /embeddings -------------------------------------------------------- */
if (!embeddingModel) {
  info("EMBEDDING_MODEL not set — skipping the /embeddings check");
} else {
  step(`POST ${baseUrl}/embeddings (model=${embeddingModel})`);
  const embed = await request(`${baseUrl}/embeddings`, {
    method: "POST",
    headers,
    timeoutMs,
    body: { model: embeddingModel, input: "outlook ai orchestrator" },
  });
  if (!embed.ok) {
    warn(
      `POST /embeddings -> ${embed.status || "no response"} ${embed.error ?? ""} ` +
        "(semantic search will degrade to lexical-only)",
    );
    info(preview(embed.body));
  } else {
    const dimensions = embed.json?.data?.[0]?.embedding?.length;
    ok("embeddings endpoint reachable");
    info(`embedding dimension: ${dimensions} (EMBEDDING_DIMENSIONS=${expectedDimensions || "?"})`);
    if (expectedDimensions && dimensions && dimensions !== expectedDimensions) {
      fail(
        `dimension mismatch: the endpoint returns ${dimensions} but EMBEDDING_DIMENSIONS=${expectedDimensions}. ` +
          "The SQL migrations declare vector(EMBEDDING_DIMENSIONS): fix .env before migrating.",
      );
      failed = true;
    }
  }
}

console.log("");
if (failed) {
  fail("the internal LLM configuration is NOT usable as-is (see above).");
  process.exit(1);
}
ok("internal LLM configuration looks valid.");

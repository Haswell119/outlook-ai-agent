#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Validates Longbow's internal LLM configuration directly against the
# OpenAI-compatible endpoint (vLLM / Ollama / TGI / Azure OpenAI private),
# independently of the orchestrator. Reads LLM_* from .env (or the current
# environment, which takes precedence).
#
# Usage: ./scripts/check-llm.sh [path-to-env-file]   (default: ./.env)
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"

if [ -f "$ENV_FILE" ]; then
  echo "==> Loading $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "!! $ENV_FILE not found — relying on already-exported environment variables." >&2
fi

LLM_BASE_URL="${LLM_BASE_URL:-}"
LLM_MODEL="${LLM_MODEL:-}"
LLM_API_KEY="${LLM_API_KEY:-}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-}"

if [ -z "$LLM_BASE_URL" ]; then
  echo "KO: LLM_BASE_URL is not set." >&2
  exit 1
fi

AUTH_HEADER=()
if [ -n "$LLM_API_KEY" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $LLM_API_KEY")
fi

echo "==> Checking $LLM_BASE_URL/models"
MODELS_RESPONSE="$(curl -sS -m 15 -w '\n%{http_code}' "${AUTH_HEADER[@]}" "$LLM_BASE_URL/models" 2>&1)"
MODELS_STATUS="$(printf '%s' "$MODELS_RESPONSE" | tail -n1)"
MODELS_BODY="$(printf '%s' "$MODELS_RESPONSE" | sed '$d')"

if [ "$MODELS_STATUS" != "200" ]; then
  echo "KO: GET $LLM_BASE_URL/models returned HTTP $MODELS_STATUS" >&2
  echo "$MODELS_BODY" >&2
  exit 1
fi
echo "OK: /models reachable"
if command -v node >/dev/null 2>&1; then
  node -e '
    try {
      const data = JSON.parse(process.argv[1]);
      const ids = (data.data || []).map((m) => m.id);
      console.log("    served models:", ids.join(", ") || "(empty list)");
      if (process.argv[2] && !ids.includes(process.argv[2])) {
        console.log("    WARNING: LLM_MODEL=" + process.argv[2] + " not found in the served list above (check --served-model-name).");
      }
    } catch (e) { console.log("    (could not parse /models body)"); }
  ' "$MODELS_BODY" "$LLM_MODEL" || true
fi

if [ -z "$LLM_MODEL" ]; then
  echo "KO: LLM_MODEL is not set — cannot run the chat completion check." >&2
  exit 1
fi

echo "==> Checking $LLM_BASE_URL/chat/completions with model=$LLM_MODEL"
CHAT_PAYLOAD=$(node -e '
  console.log(JSON.stringify({
    model: process.argv[1],
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    max_tokens: 16,
    temperature: 0,
  }));
' "$LLM_MODEL")

CHAT_RESPONSE="$(curl -sS -m 30 -w '\n%{http_code}' -X POST "$LLM_BASE_URL/chat/completions" \
  -H "Content-Type: application/json" "${AUTH_HEADER[@]}" \
  -d "$CHAT_PAYLOAD" 2>&1)"
CHAT_STATUS="$(printf '%s' "$CHAT_RESPONSE" | tail -n1)"
CHAT_BODY="$(printf '%s' "$CHAT_RESPONSE" | sed '$d')"

if [ "$CHAT_STATUS" != "200" ]; then
  echo "KO: POST $LLM_BASE_URL/chat/completions returned HTTP $CHAT_STATUS" >&2
  echo "$CHAT_BODY" >&2
  exit 1
fi
echo "OK: chat completion succeeded"
echo "$CHAT_BODY" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(raw);
      const content = data.choices?.[0]?.message?.content ?? "(no content field)";
      console.log("    model replied:", JSON.stringify(content).slice(0, 200));
    } catch (e) { console.log("    (could not parse chat completion body)"); }
  });
' || true

if [ -n "$EMBEDDING_MODEL" ]; then
  echo "==> Checking $LLM_BASE_URL/embeddings with model=$EMBEDDING_MODEL"
  EMBED_PAYLOAD=$(node -e 'console.log(JSON.stringify({ model: process.argv[1], input: "outlook ai orchestrator" }));' "$EMBEDDING_MODEL")
  EMBED_RESPONSE="$(curl -sS -m 30 -w '\n%{http_code}' -X POST "$LLM_BASE_URL/embeddings" \
    -H "Content-Type: application/json" "${AUTH_HEADER[@]}" \
    -d "$EMBED_PAYLOAD" 2>&1)"
  EMBED_STATUS="$(printf '%s' "$EMBED_RESPONSE" | tail -n1)"
  EMBED_BODY="$(printf '%s' "$EMBED_RESPONSE" | sed '$d')"
  if [ "$EMBED_STATUS" != "200" ]; then
    echo "KO: POST $LLM_BASE_URL/embeddings returned HTTP $EMBED_STATUS (EMBEDDINGS_ENABLED features will degrade to lexical-only search)" >&2
    echo "$EMBED_BODY" >&2
  else
    echo "OK: embeddings endpoint reachable"
    echo "$EMBED_BODY" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        try {
          const data = JSON.parse(raw);
          const dim = data.data?.[0]?.embedding?.length;
          console.log("    embedding dimension:", dim, "(expected EMBEDDING_DIMENSIONS=" + (process.env.EMBEDDING_DIMENSIONS || "?") + ")");
        } catch (e) { console.log("    (could not parse embeddings body)"); }
      });
    ' || true
  fi
else
  echo "==> EMBEDDING_MODEL not set, skipping /embeddings check"
fi

echo ""
echo "==> OK: Longbow internal LLM configuration looks valid."

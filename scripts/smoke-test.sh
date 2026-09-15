#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# End-to-end smoke test against a running orchestrator: health, analyze/email,
# compliance/check, chat. Works out of the box against a demo-mode instance
# (LLM_PROVIDER=mock, DATABASE_URL=memory, AUTH_MODE=dev).
#
# Usage: ORCHESTRATOR_URL=http://localhost:8080 ./scripts/smoke-test.sh
# ---------------------------------------------------------------------------
set -uo pipefail

BASE_URL="${ORCHESTRATOR_URL:-http://localhost:8080}"
API="$BASE_URL/api/v1"
USER_EMAIL="${SMOKE_TEST_USER_EMAIL:-smoke-test@longbow.ch}"
FAILED=0

pass() { echo "OK   $1"; }
fail() { echo "FAIL $1: $2" >&2; FAILED=1; }

req() {
  # req METHOD PATH [JSON_BODY]  -> prints "STATUS\nBODY"
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -m 30 -w '\n%{http_code}' -X "$method" "$API$path"
    -H "Content-Type: application/json"
    -H "x-user-email: $USER_EMAIL"
    -H "x-user-name: Smoke Test")
  if [ -n "$body" ]; then
    args+=(-d "$body")
  fi
  curl "${args[@]}"
}

echo "==> Outlook AI Orchestrator smoke test — $API"

# --- 1. Health --------------------------------------------------------------
RESP="$(curl -sS -m 10 -w '\n%{http_code}' "$API/health" 2>&1)"
STATUS="$(printf '%s' "$RESP" | tail -n1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
if [ "$STATUS" = "200" ]; then
  pass "GET /health ($BODY)"
else
  fail "GET /health" "HTTP $STATUS — $BODY"
fi

# --- 2. Analyze email --------------------------------------------------------
EMAIL_JSON=$(cat <<'JSON'
{
  "email": {
    "id": "smoke-test-email-1",
    "conversationId": "smoke-test-conv-1",
    "subject": "Q2 vendor risk assessment — please review",
    "from": { "name": "Sarah Johnson", "address": "sarah.johnson@vendorco.com" },
    "to": [{ "name": "Smoke Test", "address": "smoke-test@longbow.ch" }],
    "body": "Hi, please find attached the Q2 vendor risk assessment report. There are a few high-risk findings that need your review and approval before Friday.",
    "attachments": [{ "name": "Q2-vendor-risk-assessment.pdf", "contentType": "application/pdf" }]
  },
  "language": "en"
}
JSON
)
RESP="$(req POST /analyze/email "$EMAIL_JSON")"
STATUS="$(printf '%s' "$RESP" | tail -n1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
if [ "$STATUS" = "200" ]; then
  pass "POST /analyze/email"
  echo "     $(printf '%s' "$BODY" | head -c 200)..."
else
  fail "POST /analyze/email" "HTTP $STATUS — $BODY"
fi

# --- 3. Compliance check ------------------------------------------------------
COMPLIANCE_JSON=$(cat <<'JSON'
{
  "draft": {
    "to": [{ "name": "Michael Brown", "address": "michael.brown@clientco.com" }],
    "subject": "Q2 Performance Report — Client A",
    "body": "Hi Michael, attached is the confidential Q2 performance report with portfolio account number 123456789.",
    "attachments": [{ "name": "Client A - Q2 Performance Report.pdf", "contentType": "application/pdf" }]
  },
  "language": "en"
}
JSON
)
RESP="$(req POST /compliance/check "$COMPLIANCE_JSON")"
STATUS="$(printf '%s' "$RESP" | tail -n1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
if [ "$STATUS" = "200" ]; then
  pass "POST /compliance/check"
  echo "     $(printf '%s' "$BODY" | head -c 200)..."
else
  fail "POST /compliance/check" "HTTP $STATUS — $BODY"
fi

# --- 4. Chat ------------------------------------------------------------------
CHAT_JSON=$(cat <<'JSON'
{
  "message": "Find the email where the client approved the mandate.",
  "language": "en"
}
JSON
)
RESP="$(req POST /chat "$CHAT_JSON")"
STATUS="$(printf '%s' "$RESP" | tail -n1)"
BODY="$(printf '%s' "$RESP" | sed '$d')"
if [ "$STATUS" = "200" ]; then
  pass "POST /chat"
  echo "     $(printf '%s' "$BODY" | head -c 200)..."
else
  fail "POST /chat" "HTTP $STATUS — $BODY"
fi

echo ""
if [ "$FAILED" = "0" ]; then
  echo "==> All smoke tests passed."
else
  echo "==> Some smoke tests FAILED (see above)." >&2
fi
exit "$FAILED"

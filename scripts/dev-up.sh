#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Dev bootstrap: start Postgres/pgvector only (docker-compose.dev.yml), copy
# .env.example -> .env if missing, install deps, build @oao/shared, and print
# the next commands to run the three apps with pnpm (hot reload).
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Outlook AI Orchestrator — dev-up"

if [ ! -f .env ]; then
  echo "==> .env not found, copying .env.example -> .env"
  cp .env.example .env
else
  echo "==> .env already exists, leaving it untouched"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "!! docker not found — install Docker to run Postgres locally." >&2
  echo "!! Alternatively set DATABASE_URL=memory in .env to skip Postgres entirely." >&2
else
  echo "==> Starting Postgres (pgvector) via docker-compose.dev.yml"
  docker compose -f docker-compose.dev.yml up -d
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "!! pnpm not found. Install it first: corepack enable && corepack prepare pnpm@10.33.0 --activate" >&2
  exit 1
fi

echo "==> Installing dependencies (pnpm install)"
pnpm install --frozen-lockfile=false

echo "==> Building @oao/shared"
pnpm --filter @oao/shared build

cat <<'EOF'

==> Ready. Next steps:

  Demo mode (mock LLM, in-memory DB, fastest way to see the app):
    (edit .env: LLM_PROVIDER=mock, DATABASE_URL=memory)
    pnpm dev

  Full local stack (real Postgres, still-mock LLM unless you set LLM_*):
    pnpm --filter @oao/orchestrator db:migrate
    pnpm --filter @oao/orchestrator db:seed
    pnpm dev

  Dev HTTPS cert for the add-in (Office.js requires HTTPS on localhost:3000):
    ./scripts/gen-dev-cert.sh

  Sideload the dev manifest into Outlook: see docs/SETUP.md or
  ./scripts/sideload-manifest.ps1 (Windows / classic Outlook).

Apps once running:
  orchestrator  http://localhost:8080   (health: /api/v1/health)
  addin         https://localhost:3000
  admin         http://localhost:3001

EOF

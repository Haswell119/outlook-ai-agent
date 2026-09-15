#!/usr/bin/env bash
# Stops the dev Postgres container started by dev-up.sh / docker-compose.dev.yml.
# Pass --volumes (or -v) to also delete the Postgres data volume.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "!! docker not found — nothing to stop." >&2
  exit 0
fi

if [[ "${1:-}" == "--volumes" || "${1:-}" == "-v" ]]; then
  echo "==> Stopping dev stack and removing the Postgres data volume"
  docker compose -f docker-compose.dev.yml down --volumes
else
  echo "==> Stopping dev stack (data volume kept, use --volumes to wipe it)"
  docker compose -f docker-compose.dev.yml down
fi

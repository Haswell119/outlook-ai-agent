# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# @oao/orchestrator — Node 20 / Fastify 5 / PostgreSQL(pgvector)
# Multi-stage build from the monorepo root (build context = repo root).
#
#   docker build -f infra/docker/orchestrator.Dockerfile -t oao/orchestrator .
# ---------------------------------------------------------------------------

# ---- base: pnpm via corepack -----------------------------------------------
FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NODE_ENV=production
WORKDIR /repo

# ---- deps: install full workspace deps needed to build shared+orchestrator -
FROM base AS deps
ENV NODE_ENV=development
# Only the manifests first, for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/orchestrator/package.json apps/orchestrator/package.json
RUN pnpm install --frozen-lockfile=false --filter @oao/orchestrator... --filter @oao/shared

# ---- build: compile shared then orchestrator -------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/orchestrator apps/orchestrator
RUN pnpm --filter @oao/shared build \
 && pnpm --filter @oao/orchestrator build

# Prune devDependencies out of node_modules for a slimmer runtime image.
# `pnpm deploy` resolves the workspace:* dependency on @oao/shared into a
# regular, self-contained node_modules tree for just this package.
RUN pnpm --filter @oao/orchestrator deploy --prod /tmp/deploy/orchestrator

# ---- runtime -----------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

RUN groupadd --system --gid 1001 oao \
 && useradd --system --uid 1001 --gid oao --home-dir /app --shell /usr/sbin/nologin oao \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Deployed, pruned workspace (node_modules + package.json) for the orchestrator.
COPY --from=build --chown=oao:oao /tmp/deploy/orchestrator/node_modules ./node_modules
COPY --from=build --chown=oao:oao /tmp/deploy/orchestrator/package.json ./package.json
# Compiled app + SQL migrations (read at runtime by the migration runner).
COPY --from=build --chown=oao:oao /repo/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=build --chown=oao:oao /repo/apps/orchestrator/migrations ./apps/orchestrator/migrations

USER oao
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" || exit 1

CMD ["node", "apps/orchestrator/dist/server.js"]

# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# @oao/orchestrator — Node 22 / Fastify 5 / PostgreSQL(pgvector)
# One image, two roles: ROLE=api (HTTP) and ROLE=worker (sync/precompute/
# retention). The same image also runs the migration Job.
#
# Build context = repo root:
#   docker build -f infra/docker/orchestrator.Dockerfile -t oao/orchestrator .
#
# Runtime guarantees (relied on by infra/helm):
#   - non-root (uid/gid 1001)
#   - read-only root filesystem compatible: only /tmp is written
#   - secrets accepted as <NAME>_FILE pointing at a mounted file
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=10.33.0

# ---- base: pnpm via corepack ----------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---- deps: warm the pnpm store, then install the orchestrator subgraph -----
FROM base AS deps
# Lockfile first: `pnpm fetch` only needs it, so the (cached) download layer is
# invalidated only when dependencies actually change.
COPY pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm fetch
# Every workspace manifest, so --frozen-lockfile can verify the whole graph.
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/admin/package.json apps/admin/
COPY apps/addin/package.json apps/addin/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @oao/orchestrator... --filter @oao/shared

# ---- build: compile shared then orchestrator, then prune ------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/orchestrator apps/orchestrator
RUN pnpm --filter @oao/shared build \
 && pnpm --filter @oao/orchestrator build
# `pnpm deploy --prod` resolves the workspace:* dependency on @oao/shared into
# a self-contained, devDependency-free node_modules tree.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm --filter @oao/orchestrator deploy --prod --legacy /tmp/deploy/orchestrator

# ---- runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="oao-orchestrator" \
      org.opencontainers.image.description="Outlook AI Orchestrator — API and background worker (Fastify 5, PostgreSQL/pgvector)" \
      org.opencontainers.image.vendor="Northbridge Capital" \
      org.opencontainers.image.licenses="Proprietary" \
      org.opencontainers.image.source="https://github.com/northbridge-capital/outlook-ai-agent" \
      org.opencontainers.image.documentation="https://github.com/northbridge-capital/outlook-ai-agent/blob/main/docs/NKP.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    ROLE=all \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

RUN groupadd --system --gid 1001 oao \
 && useradd --system --uid 1001 --gid oao --home-dir /app --shell /usr/sbin/nologin oao

# Deployed, pruned workspace (node_modules + package.json).
COPY --from=build --chown=root:root /tmp/deploy/orchestrator/node_modules ./node_modules
COPY --from=build --chown=root:root /tmp/deploy/orchestrator/package.json ./package.json
# Compiled app + SQL migrations (read at runtime by the migration runner).
COPY --from=build --chown=root:root /repo/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=build --chown=root:root /repo/apps/orchestrator/migrations ./apps/orchestrator/migrations

USER 1001:1001
EXPOSE 8080

# No curl in the image (smaller attack surface): Node's global fetch is enough.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/api/v1/live`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/orchestrator/dist/server.js"]

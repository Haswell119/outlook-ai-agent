# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# @oao/admin — Next.js 15 (App Router), output: "standalone", port 3001.
# Multi-stage build from the monorepo root (build context = repo root).
#
#   docker build -f infra/docker/admin.Dockerfile -t oao/admin .
# ---------------------------------------------------------------------------

FROM node:20-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --frozen-lockfile=false --filter @oao/admin... --filter @oao/shared

# ---- build --------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/admin apps/admin
# Public, non-secret build-time config (server env like ORCHESTRATOR_URL is read at
# runtime by the Next server, not baked in — see apps/admin/src/*).
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @oao/shared build \
 && pnpm --filter @oao/admin build

# ---- runtime ------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app

RUN groupadd --system --gid 1001 oao \
 && useradd --system --uid 1001 --gid oao --home-dir /app --shell /usr/sbin/nologin oao \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Next's "standalone" output traces the monorepo and keeps the workspace layout,
# so the entrypoint lives at apps/admin/server.js inside the standalone folder.
COPY --from=build --chown=oao:oao /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=oao:oao /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=build --chown=oao:oao /repo/apps/admin/public ./apps/admin/public

USER oao
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/" || exit 1

CMD ["node", "apps/admin/server.js"]

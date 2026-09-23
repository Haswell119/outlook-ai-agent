# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# @oao/orchestrator — Node 22 / Fastify 5 / PostgreSQL(pgvector)
# One image, two roles: ROLE=api (HTTP) and ROLE=worker (sync/precompute/
# retention). The same image also runs the migration Job.
#
# Build context = repo root:
#   docker build -f infra/docker/orchestrator.Dockerfile -t oao/orchestrator .
#
# Package manager: npm only (it ships with the node:22 image — no Corepack,
# no global install). `npm ci` is reproducible: it installs exactly what
# package-lock.json describes, or fails.
#
# Runtime guarantees (relied on by infra/helm):
#   - non-root (uid/gid 1001)
#   - read-only root filesystem compatible: only /tmp is written
#   - secrets accepted as <NAME>_FILE pointing at a mounted file
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- base -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
WORKDIR /repo

# ---- deps: the full (dev included) tree needed to compile -------------------
FROM base AS deps
# Manifests first: the install layer is invalidated only when a dependency
# actually changes, not on every source edit. Every workspace manifest is
# copied because npm resolves the whole workspace graph from the root lockfile.
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/admin/package.json apps/admin/
COPY apps/addin/package.json apps/addin/
RUN --mount=type=cache,id=npm-cache,target=/root/.npm,sharing=locked \
    npm ci --workspace @oao/shared --workspace @oao/orchestrator

# ---- build: compile shared, then the orchestrator --------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/orchestrator apps/orchestrator
RUN npm run build -w @oao/shared \
 && npm run build -w @oao/orchestrator

# ---- prod-deps: a clean, devDependency-free tree ---------------------------
# A second `npm ci` into a pristine directory is smaller *and* more predictable
# than pruning the build tree in place: no build tool ever reaches the runtime
# layer. The workspace links it creates (node_modules/@oao/* -> ../../…) are
# relative, so the layout below resolves unchanged under /app.
FROM base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/admin/package.json apps/admin/
COPY apps/addin/package.json apps/addin/
RUN --mount=type=cache,id=npm-cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --workspace @oao/shared --workspace @oao/orchestrator

# ---- runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG NODE_IMAGE
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

# Production dependency tree + the manifests its workspace links point at.
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=prod-deps --chown=root:root /app/package.json ./package.json
COPY --from=prod-deps --chown=root:root /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps --chown=root:root /app/apps/orchestrator/package.json ./apps/orchestrator/package.json
# Compiled workspaces + SQL migrations (read at runtime by the migration runner).
COPY --from=build --chown=root:root /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=root:root /repo/apps/orchestrator/dist ./apps/orchestrator/dist
COPY --from=build --chown=root:root /repo/apps/orchestrator/migrations ./apps/orchestrator/migrations
# Example decision taxonomy, used only when LAYA_TAXONOMY_FILE is empty (dev /
# shadow trials). Production mounts its own file (Helm ConfigMap).
COPY --from=build --chown=root:root /repo/apps/orchestrator/config ./apps/orchestrator/config

USER 1001:1001
EXPOSE 8080

# No curl in the image (smaller attack surface): Node's global fetch is enough.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8080}/api/v1/live`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/orchestrator/dist/server.js"]

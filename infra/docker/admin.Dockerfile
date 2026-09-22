# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# @oao/admin — Next.js 15 (App Router), output: "standalone", port 3001.
#
#   docker build -f infra/docker/admin.Dockerfile -t oao/admin .
#
# Package manager: npm only (shipped with the node:22 image — no Corepack).
# `npm ci` installs exactly what package-lock.json describes, or fails.
#
# Runtime guarantees (relied on by infra/helm):
#   - non-root (uid/gid 1001)
#   - read-only root filesystem compatible: /tmp and
#     /app/apps/admin/.next/cache are the only writable paths (emptyDir)
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
# Manifests first so the install layer survives source edits. All four are
# copied: npm resolves the workspace graph from the root lockfile, and the
# root `overrides` block is what keeps `next` (and React 19) inside
# apps/admin/node_modules instead of hoisting it next to the add-in's React 18.
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/admin/package.json apps/admin/
COPY apps/addin/package.json apps/addin/
RUN --mount=type=cache,id=npm-cache,target=/root/.npm,sharing=locked \
    npm ci --workspace @oao/shared --workspace @oao/admin

# ---- build --------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/admin apps/admin
# Server-side config (ORCHESTRATOR_URL, ADMIN_AUTH_MODE, AUTH_MICROSOFT_ENTRA_ID_*)
# is read at runtime by the Next server — nothing secret is baked in here.
RUN npm run build -w @oao/shared \
 && npm run build -w @oao/admin

# ---- runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG NODE_IMAGE
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="oao-admin" \
      org.opencontainers.image.description="Outlook AI Orchestrator — supervision dashboard (Next.js, audit/approvals/policy)" \
      org.opencontainers.image.vendor="Northbridge Capital" \
      org.opencontainers.image.licenses="Proprietary" \
      org.opencontainers.image.source="https://github.com/northbridge-capital/outlook-ai-agent" \
      org.opencontainers.image.documentation="https://github.com/northbridge-capital/outlook-ai-agent/blob/main/docs/NKP.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${NODE_IMAGE}"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app

RUN groupadd --system --gid 1001 oao \
 && useradd --system --uid 1001 --gid oao --home-dir /app --shell /usr/sbin/nologin oao

# Next's "standalone" output keeps the monorepo layout: the folder contains
# `apps/admin/server.js`, the traced `node_modules` (with this workspace's own
# React 19 under apps/admin/node_modules) and `packages/shared`. No further
# `npm install` is needed in the runtime stage.
COPY --from=build --chown=root:root /repo/apps/admin/.next/standalone ./
COPY --from=build --chown=root:root /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=build --chown=root:root /repo/apps/admin/public ./apps/admin/public
# Writable cache dir for a read-only root filesystem (overlaid by an emptyDir
# in Kubernetes; still needed for plain `docker run`).
RUN mkdir -p /app/apps/admin/.next/cache && chown -R 1001:1001 /app/apps/admin/.next/cache

USER 1001:1001
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||3001}/api/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "apps/admin/server.js"]

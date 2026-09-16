# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# @oao/admin — Next.js 15 (App Router), output: "standalone", port 3001.
#
#   docker build -f infra/docker/admin.Dockerfile -t oao/admin .
#
# Runtime guarantees (relied on by infra/helm):
#   - non-root (uid/gid 1001)
#   - read-only root filesystem compatible: /tmp and
#     /app/apps/admin/.next/cache are the only writable paths (emptyDir)
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:20-bookworm-slim
ARG PNPM_VERSION=10.33.0

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm fetch
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/admin/package.json apps/admin/
COPY apps/addin/package.json apps/addin/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --filter @oao/admin... --filter @oao/shared

# ---- build --------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/admin apps/admin
# Server-side config (ORCHESTRATOR_URL, ADMIN_AUTH_MODE, AUTH_MICROSOFT_ENTRA_ID_*)
# is read at runtime by the Next server — nothing secret is baked in here.
RUN pnpm --filter @oao/shared build \
 && pnpm --filter @oao/admin build

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

# Next's "standalone" output keeps the monorepo layout, so the entrypoint is
# apps/admin/server.js inside the standalone folder.
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

# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# @oao/addin — Vite static build (taskpane.html, commands.html, assets/)
# served by nginx over HTTPS, ready for Office add-in embedding.
# Multi-stage build from the monorepo root (build context = repo root).
#
#   docker build -f infra/docker/addin.Dockerfile \
#     --build-arg VITE_API_BASE_URL=https://api.oao.longbow.local/api/v1 \
#     --build-arg VITE_ADMIN_URL=https://admin.oao.longbow.local \
#     --build-arg VITE_AUTH_MODE=aad \
#     --build-arg VITE_API_MOCK=false \
#     -t oao/addin .
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
COPY apps/addin/package.json apps/addin/package.json
RUN pnpm install --frozen-lockfile=false --filter @oao/addin... --filter @oao/shared

# ---- build --------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/addin apps/addin

# Build-time env consumed by Vite (baked into the static bundle).
ARG VITE_API_BASE_URL=https://api.oao.longbow.local/api/v1
ARG VITE_ADMIN_URL=https://admin.oao.longbow.local
ARG VITE_AUTH_MODE=aad
ARG VITE_API_MOCK=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_ADMIN_URL=$VITE_ADMIN_URL \
    VITE_AUTH_MODE=$VITE_AUTH_MODE \
    VITE_API_MOCK=$VITE_API_MOCK

RUN pnpm --filter @oao/shared build \
 && pnpm --filter @oao/addin build

# ---- runtime: nginx (unprivileged image = non-root by default) --------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

USER root
RUN apk add --no-cache curl openssl \
 && mkdir -p /etc/nginx/certs \
 && chown -R nginx:nginx /etc/nginx/certs

COPY infra/docker/nginx.conf /etc/nginx/nginx.conf
COPY infra/docker/addin-entrypoint.sh /docker-entrypoint.d/00-gen-cert.sh
RUN chmod +x /docker-entrypoint.d/00-gen-cert.sh

COPY --from=build --chown=nginx:nginx /repo/apps/addin/dist /usr/share/nginx/html

USER nginx
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD curl -fsSk https://127.0.0.1:3000/healthz || exit 1

# Base image's own /docker-entrypoint.sh runs every executable script in
# /docker-entrypoint.d/ (our cert-gen script included) before exec'ing CMD.
CMD ["nginx", "-g", "daemon off;"]

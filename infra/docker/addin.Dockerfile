# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# @oao/addin — Vite static build (taskpane.html, commands.html, assets/)
# served by nginx over HTTPS, embeddable in Outlook's iframe.
#
#   docker build -f infra/docker/addin.Dockerfile \
#     --build-arg ADDIN_HOST=addin.oao.northbridge.example \
#     --build-arg API_HOST=api.oao.northbridge.example \
#     --build-arg AAD_CLIENT_ID=<add-in app registration client id> \
#     -t oao/addin .
#
# Everything host-specific (VITE_* and the Office manifests) is baked in at
# BUILD time: a manifest is a release artifact, immutable like the bundle it
# points at. One image per environment, therefore — the tags produced by
# release.yml are per-version, and dev/prod use different values.
#
# Runtime guarantees (relied on by infra/helm):
#   - non-root (nginx uid/gid 101)
#   - read-only root filesystem compatible: /tmp, /var/cache/nginx,
#     /etc/nginx/conf.d and /etc/nginx/certs are the only writable paths
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:20-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine
ARG PNPM_VERSION=10.33.0

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=1
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
    pnpm install --frozen-lockfile --filter @oao/addin... --filter @oao/shared

# ---- build --------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/addin apps/addin

# Hostnames (bare, like `hosts.*` in the Helm chart). The manifest renderer
# wants full URLs, hence the https:// prefixes on the RUN line below.
ARG ADDIN_HOST=addin.oao.northbridge.example
ARG API_HOST=api.oao.northbridge.example
ARG ADMIN_HOST=admin.oao.northbridge.example
ARG AAD_CLIENT_ID=""
ARG ADDIN_VERSION=1.0.0.0
ARG ORGANIZATION_NAME="Northbridge Capital"
ARG VITE_AUTH_MODE=aad
ARG VITE_API_MOCK=false
ENV VITE_API_BASE_URL=https://$API_HOST/api/v1 \
    VITE_ADMIN_URL=https://$ADMIN_HOST \
    VITE_AUTH_MODE=$VITE_AUTH_MODE \
    VITE_API_MOCK=$VITE_API_MOCK

RUN pnpm --filter @oao/shared build \
 && pnpm --filter @oao/addin build \
 && ADDIN_HOST="https://$ADDIN_HOST" \
    API_HOST="https://$API_HOST" \
    AAD_CLIENT_ID="$AAD_CLIENT_ID" \
    ADDIN_VERSION="$ADDIN_VERSION" \
    ORGANIZATION_NAME="$ORGANIZATION_NAME" \
    pnpm --filter @oao/addin run --if-present manifest:render

# ---- runtime: nginx (unprivileged image = non-root by default) --------------
FROM ${NGINX_IMAGE} AS runtime
ARG NGINX_IMAGE
ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
ARG ADDIN_HOST=addin.oao.northbridge.example
LABEL org.opencontainers.image.title="oao-addin" \
      org.opencontainers.image.description="Outlook AI Orchestrator — Outlook add-in task pane (static bundle + Office manifests) served over HTTPS" \
      org.opencontainers.image.vendor="Northbridge Capital" \
      org.opencontainers.image.licenses="Proprietary" \
      org.opencontainers.image.source="https://github.com/northbridge-capital/outlook-ai-agent" \
      org.opencontainers.image.documentation="https://github.com/northbridge-capital/outlook-ai-agent/blob/main/docs/SETUP.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.base.name="${NGINX_IMAGE}"

ENV ADDIN_HOST=$ADDIN_HOST

USER root
# openssl: last-resort self-signed certificate when none is mounted (dev only).
RUN apk add --no-cache openssl \
 && mkdir -p /etc/nginx/certs \
 && chown -R 101:101 /etc/nginx/certs

COPY infra/docker/nginx.conf /etc/nginx/nginx.conf
COPY infra/docker/addin-entrypoint.sh /docker-entrypoint.d/00-gen-cert.sh
RUN chmod 0755 /docker-entrypoint.d/00-gen-cert.sh

COPY --from=build --chown=root:root /repo/apps/addin/dist /usr/share/nginx/html
# Office manifests, served at https://<host>/manifest/manifest.xml for
# centralised M365 deployment and for `Add from URL` sideloading.
COPY --from=build --chown=root:root /repo/apps/addin/manifest /usr/share/nginx/html/manifest

USER 101:101
EXPOSE 3000

# busybox wget (no curl in the image): -q --no-check-certificate because the
# certificate may be the container's own self-signed one.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q --no-check-certificate -O /dev/null https://127.0.0.1:3000/healthz || exit 1

# The base image's /docker-entrypoint.sh runs every executable script in
# /docker-entrypoint.d/ (our cert bootstrap included) before exec'ing CMD.
CMD ["nginx", "-g", "daemon off;"]

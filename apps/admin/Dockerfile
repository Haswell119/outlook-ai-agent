# syntax=docker/dockerfile:1
# Build from the REPOSITORY ROOT:
#   docker build -f apps/admin/Dockerfile -t oao-admin:0.1.0 .
FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/admin ./apps/admin
RUN pnpm install --frozen-lockfile --filter @oao/admin...
RUN pnpm --filter @oao/shared build && ADMIN_MOCK=true pnpm --filter @oao/admin build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0
# `output: "standalone"` emits a self-contained server + a minimal node_modules.
COPY --from=builder /repo/apps/admin/.next/standalone ./
COPY --from=builder /repo/apps/admin/.next/static ./apps/admin/.next/static
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]

# `@oao/admin` — Admin / supervision dashboard

The **Audit & Supervision** dashboard of the Outlook AI Orchestrator: KPIs, charts,
the full audit trail, compliance approvals, automations, the Policy Center, users
and runtime settings. Next.js 15 (App Router) + Tailwind CSS 3 + shadcn/ui +
Recharts, typed end-to-end against `@oao/shared`.

> Reference design: `docs/mockups.md` §G (dark-navy `#0B2A4A` sidebar, white
> Fluent-style cards, `#0F6CBD` accent, green/orange/red risk badges).

## Quick start

```bash
pnpm install                       # from the repository root
cp apps/admin/.env.example apps/admin/.env.local
pnpm --filter @oao/admin dev       # http://localhost:3001
```

With `ADMIN_MOCK=true` (the default in `.env.example`) the dashboard needs **no
backend at all** — every page is populated from the deterministic dataset in
`src/lib/mock-data.ts`.

## Scripts

| Script                                   | What it does                                      |
| ---------------------------------------- | ------------------------------------------------- |
| `pnpm --filter @oao/admin dev`           | Next dev server on **port 3001**                  |
| `pnpm --filter @oao/admin build`         | Production build (`output: "standalone"`)         |
| `pnpm --filter @oao/admin start`         | Serve the build on port 3001                      |
| `pnpm --filter @oao/admin typecheck`     | `tsc --noEmit`                                    |
| `pnpm --filter @oao/admin lint`          | Same as `typecheck` (no ESLint config in the repo)|
| `pnpm --filter @oao/admin test`          | Vitest (mock dataset, KPI deltas, CSV export)     |

## Environment

All of these are **server-side only** — no `NEXT_PUBLIC_*` variable exists, so the
admin token never reaches the browser. See `.env.example`.

| Variable                 | Default                  | Purpose                                                     |
| ------------------------ | ------------------------ | ----------------------------------------------------------- |
| `ORCHESTRATOR_URL`       | `http://localhost:8080`  | Base URL of the Fastify orchestrator (no trailing slash).    |
| `ADMIN_API_TOKEN`        | *(empty)*                | Sent as `Authorization: Bearer …` on every call.             |
| `ADMIN_MOCK`             | *(unset)*                | `true` → always use the mock dataset.                        |
| `ADMIN_DEFAULT_LANGUAGE` | `en`                     | `en` \| `fr`; overridden per browser by the `oao_lang` cookie. |
| `ADMIN_TENANT_NAME`      | `ABC Capital`            | Tenant label in the top bar and the footer.                  |

Every request also forwards `Accept-Language` derived from the current UI language.

## Mock data mode

Three ways the mock dataset is used:

1. **Forced** — `ADMIN_MOCK=true`.
2. **Automatic development fallback** — the orchestrator is probed (`GET /api/v1/health`,
   2.5 s timeout, result cached 15 s). If it is unreachable, or answers 5xx, and
   `NODE_ENV !== "production"`, a warning is logged
   (`[@oao/admin] orchestrator unreachable at … — falling back to ADMIN_MOCK data.`)
   and the dataset takes over. In production the error propagates instead.
3. Either way a yellow **“Mock data”** pill appears in the top bar (hover for the reason).

The dataset (`src/lib/mock-data.ts`) is deterministic — a seeded `mulberry32` PRNG,
so every process and every build produce the same rows:

* **1,247 audit events** over 12–18 May 2025, across 6 users of *ABC Capital* /
  *Northbridge Capital*, with realistic risk levels, approval statuses, model,
  latency, confidence, SHA-256 prompt/response hashes and correlation ids.
* KPIs pinned to the mock-up: **8,642 / 2,341 / 186 / 142 / 37 / 1,216** with deltas
  +12.4 / +9.7 / +15.3 / +13.8 / +8.3 / +18.6 %.
* Actions by type **63.8 / 17.3 / 9.6 / 5.4 / 3.9 %** of 13,547 total actions;
  compliance alerts by category **35.1 / 27.0 / 18.9 / 10.8 / 8.2 %** of 37.
* Automations approval rate **76 %** vs **68 %** last week.
* **3 automations** (one with a full simulation), **4 escalations** (2 pending),
  6 users, the default `Policy`, feature flags and a degraded `Health`.

Mutations in mock mode are applied to an in-memory store held on `globalThis`, so
approving an escalation or pausing an automation is visible until the server restarts.

## How data flows

* **Reads** — Server Components call `src/lib/api.ts`, which fetches the routes from
  `Routes` in `@oao/shared` and validates every payload with the shared zod schemas.
  All data pages are `dynamic = "force-dynamic"`.
* **Writes** — the browser calls route handlers under `src/app/api/*`, which validate
  the body and proxy to the orchestrator (or the mock store):

  | Route handler                              | Target                                        |
  | ------------------------------------------ | --------------------------------------------- |
  | `POST /api/escalations/[id]/decision`      | `POST Routes.escalationDecision(id)`          |
  | `POST /api/automations/[id]/decision`      | `Routes.automationApprove/Reject(id)`, or `PATCH Routes.automation(id)` for *pause* |
  | `GET  /api/policy` · `PUT /api/policy`     | `Routes.adminPolicy` (validated with `PolicySchema`) |
  | `GET  /api/audit/export`                   | `Routes.audit` → CSV attachment               |
  | `GET  /api/health`                         | `Routes.health` + `Routes.features` (“Re-check”) |
  | `POST /api/language`                       | sets the `oao_lang` cookie                    |

## Pages

| Route           | Contents                                                                              |
| --------------- | ------------------------------------------------------------------------------------- |
| `/`             | Audit & Supervision: date range + Filters sheet + Export, 6 KPI tiles, activity line chart, two donuts, Filters card, Insights card, audit log with pagination |
| `/audit`        | Full audit log: search, four filters, page size, export                               |
| `/approvals`    | Compliance escalations as cards (issues, draft recipients, attachments), Approve/Reject with a comment dialog, tabs Pending / Decided |
| `/alerts`       | Compliance alerts, escalations and non-clean phishing checks grouped by category, severity filter |
| `/automations`  | Automations table (+ card layout under 1024 px), detail sheet with the step flow and last simulation, Approve / Pause / Reject |
| `/policy`       | Policy Center: tag inputs, sensitive-data pattern table, thresholds, compliance-approval multi-select, `blockOnHighRisk` switch, zod-validated save |
| `/users`        | Users, roles, action counts, last activity                                            |
| `/analytics`    | Tabs Usage & Adoption / Performance / AI Impact                                       |
| `/settings`     | Feature flags + health with a Re-check button                                         |
| `/integrations` | Connected systems and data paths                                                      |
| `/roles`        | `user` / `compliance` / `admin` permission matrix                                     |

Filters, date range, pagination and the analytics tab all live in the URL, so any
view is shareable and the server renders it without client state.

## i18n

English by default, **EN / FR** toggle in the top bar. The dictionary is a flat map
in `src/lib/i18n.ts`; the choice is stored in the `oao_lang` cookie (one year) and
read server-side, so the first paint is already translated. Navigation, page titles
and subtitles, KPI labels, table headers, filters, buttons and dialogs are covered.

## Responsive & accessibility

Designed down to **1024 px** and usable on a phone: the sidebar collapses to icons
(state kept in `localStorage`, tooltips when collapsed), KPI tiles reflow 6 → 3 → 2 → 1,
chart rows stack, and the automations list switches to cards. Wide tables are the
only horizontally scrollable areas. Icon-only controls carry `aria-label`s.

## Screenshots

`docs/screenshots/` — `overview`, `approvals`, `automations`, `policy` (`*.png` at
1440 px, `*-1024.png` at 1024 px), captured from a production build in mock mode.

## Docker

`next.config.mjs` sets `output: "standalone"`, so the runtime image needs only the
`.next/standalone` bundle plus the static assets. From the **repository root**:

```dockerfile
# syntax=docker/dockerfile:1
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
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0
COPY --from=builder /repo/apps/admin/.next/standalone ./
COPY --from=builder /repo/apps/admin/.next/static ./apps/admin/.next/static
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]
```

The maintained Dockerfile lives in `infra/docker/admin.Dockerfile` (used by `docker-compose.yml`):

```bash
docker build -f infra/docker/admin.Dockerfile -t oao-admin:0.1.0 .
docker run --rm -p 3001:3001 \
  -e ORCHESTRATOR_URL=http://orchestrator:8080 \
  -e ADMIN_API_TOKEN=change-me \
  oao-admin:0.1.0
```

`ADMIN_MOCK=true` at build time keeps the build from needing a live orchestrator;
every page is `force-dynamic`, so nothing is baked into the image.

## Notes on the contract

`@oao/shared` was not modified. Two shapes the dashboard needs are declared locally
in `src/lib/types.ts` and should move into the contract once the backend settles:

* `GET /api/v1/admin/users` has a route but no response schema → `AdminUserSchema`
  (`UserIdentity` + `actions` + `lastActivityAt`).
* `Escalation` carries no draft context, so the recipients/attachments shown on the
  approval cards come from `MOCK_ESCALATION_DRAFTS` in mock mode and are simply
  omitted against a live orchestrator.

There is also no route for *pausing* an automation (only approve/reject), so pause
is sent as `PATCH Routes.automation(id)` with `{ status: "paused" }`, and no
dedicated alerts endpoint — `/alerts` is derived from the audit trail.

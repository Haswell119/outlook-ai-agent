# `@oao/admin` — Admin / supervision dashboard

The **Audit & Supervision** dashboard of the Outlook AI Orchestrator: KPIs and charts,
the full audit trail, compliance approvals, automations, the Policy Center, users,
system status and runtime settings. Next.js 15 (App Router) + Tailwind CSS 3 +
hand-written shadcn/ui components + Recharts, typed end-to-end against `@oao/shared`.

Production posture: **Microsoft Entra ID sign-in**, RBAC enforced in the middleware
*and* re-checked in every server component and route handler, strict CSP with a
per-request nonce, zod-validated environment, FR/EN everywhere, and an e2e suite
that runs against a real production build.

> Reference design: `docs/mockups.md` §G (dark-navy `#0B2A4A` sidebar, white
> Fluent-style cards, `#0F6CBD` accent, green/orange/red risk badges).

## Quick start

```bash
npm install                       # from the repository root
cp apps/admin/.env.example apps/admin/.env.local
npm run dev -w @oao/admin       # http://localhost:3001
```

With `ADMIN_MOCK=true` and `ADMIN_AUTH_MODE=token` (the defaults in `.env.example`)
the dashboard needs **no backend and no Entra ID tenant** — every page is populated
from the deterministic dataset in `src/lib/mock-data.ts` and you are signed in as
`ADMIN_DEV_EMAIL`.

## Scripts

| Script                                      | What it does                                                   |
| ------------------------------------------- | -------------------------------------------------------------- |
| `npm run dev -w @oao/admin`               | Next dev server on **port 3001**                                |
| `npm run build -w @oao/admin`             | Production build (`output: "standalone"`)                       |
| `npm run start -w @oao/admin`             | Serve the build on port 3001                                    |
| `npm run typecheck -w @oao/admin`         | `tsc --noEmit`                                                  |
| `npm run lint -w @oao/admin`              | Same as `typecheck` (no ESLint config in the repo)              |
| `npm run test -w @oao/admin`              | Vitest — 77 unit tests                                          |
| `npm run e2e -w @oao/admin`               | Playwright — 12 end-to-end tests (needs `build` first)          |
| `npm run analyze -w @oao/admin`           | `ANALYZE=true next build` → bundle treemaps in `.next/analyze/`  |
| `npm run screenshots -w @oao/admin`       | Refreshes `docs/screenshots/*.png` from a running build          |

Full gate: `npm run typecheck -w @oao/admin && npm run test -w @oao/admin && npm run build -w @oao/admin && npm run e2e -w @oao/admin`.

## Authentication

Two modes, selected by `ADMIN_AUTH_MODE`:

| Mode    | Sign-in                                   | Bearer sent to the orchestrator                    | Use                          |
| ------- | ----------------------------------------- | -------------------------------------------------- | ---------------------------- |
| `aad`   | Microsoft Entra ID (Auth.js v5, OIDC)      | the **operator's access token** for the API app     | production                   |
| `token` | none — the identity comes from the env     | the shared `ADMIN_API_TOKEN` + `x-user-email` header | local dev, e2e, demos        |

In `aad` mode the dashboard requests `openid profile email offline_access
api://{ORCHESTRATOR_API_CLIENT_ID}/access_as_user` at sign-in, so the session holds an
access token whose **audience is the orchestrator API app**. The token is renewed with
the refresh token 60 s before expiry (rotation: Entra ID returns a new refresh token
each time). A failed renewal marks the session `RefreshAccessTokenError`, which shows a
"session expired" banner and a toast asking for a fresh sign-in. Sessions are JWTs
(`ADMIN_SESSION_MAX_AGE`, default 1 h), never stored server-side.

### Entra ID app registration (what the operator must do)

The dashboard needs **its own** app registration, separate from the orchestrator API
app and from the add-in.

1. **Register the app** — Entra admin centre → *App registrations* → *New registration*
   → name e.g. `Outlook AI Orchestrator — Admin dashboard`, single tenant.
2. **Redirect URIs** (platform *Web*):
   - `https://oao-admin.<your-domain>/api/auth/callback/microsoft-entra-id`
   - `http://localhost:3001/api/auth/callback/microsoft-entra-id` (development only)
   - Front-channel logout URL: `https://oao-admin.<your-domain>/signin`
   - Leave *Implicit grant* unchecked — this is the authorization-code flow with PKCE.
3. **Client secret** — *Certificates & secrets* → new client secret →
   `AUTH_MICROSOFT_ENTRA_ID_SECRET`. Note the expiry in the runbook.
4. **API permission to the orchestrator** — *API permissions* → *Add a permission* →
   *My APIs* → the **orchestrator API app** → *Delegated permissions* →
   `access_as_user` → *Add*, then **Grant admin consent**. (No Microsoft Graph
   permission is needed: the dashboard never calls Graph.)
5. **App roles** — on the **orchestrator API app registration** (the audience whose
   `roles` claim the dashboard reads), *App roles* → create two:

   | Display name       | Value        | Allowed member types | Description                                   |
   | ------------------ | ------------ | -------------------- | --------------------------------------------- |
   | Administrator      | `Admin`      | Users/Groups         | Full access to the supervision dashboard      |
   | Compliance officer | `Compliance` | Users/Groups         | Approvals, alerts and the audit trail only    |

   Values are matched case-insensitively, and `Oao.Admin` / `Compliance.Officer`
   style values are accepted too.
6. **Assign people** — *Enterprise applications* → the orchestrator API app →
   *Users and groups* → assign the security groups for `Admin` and `Compliance`.
   Set *Assignment required* to **Yes** so unassigned users cannot obtain a token.
7. **Environment** — fill `AUTH_MICROSOFT_ENTRA_ID_ID/SECRET/ISSUER`,
   `ORCHESTRATOR_API_CLIENT_ID`, `AUTH_SECRET` (`openssl rand -base64 32`) and
   `AUTH_URL`, then set `ADMIN_AUTH_MODE=aad`.

Until app roles are assigned, `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` act as a fallback:
an operator whose email is listed gets the corresponding role. App roles from the token
always win.

## RBAC matrix

Roles come from the `roles` claim (`admin`, `compliance`, `user`). The table below is
the single source of truth in `src/lib/rbac.ts`, used by the middleware, by the
navigation and by `requireRoles()` in every page and route handler.

| Area                                             | `admin` | `compliance` | `user` |
| ------------------------------------------------ | :-----: | :----------: | :----: |
| `/` Overview, KPIs and charts                     |   ✅    |      —       |   —    |
| `/audit`, `/audit/[id]`, CSV export               |   ✅    |      ✅      |   —    |
| `/approvals` (decide escalations)                 |   ✅    |      ✅      |   —    |
| `/alerts`                                         |   ✅    |      ✅      |   —    |
| `/automations` (approve / pause / resume / reject)|   ✅    |      —       |   —    |
| `/policy` (edit the compliance policy)            |   ✅    |      —       |   —    |
| `/analytics`, `/users`, `/roles`, `/integrations` |   ✅    |      —       |   —    |
| `/system`, `/settings`, diagnostics export        |   ✅    |      —       |   —    |
| Landing page after sign-in                        |   `/`   | `/approvals` | `/no-access` |

A signed-in operator without `Admin` or `Compliance` lands on a friendly
**`/no-access`** page explaining that the Outlook add-in remains fully available.
Pages redirect, `/api/*` route handlers answer `401` / `403` with the contract's
`ApiError` shape.

## Ops pages

| Route            | Contents                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `/system`        | `SystemStatus`: health checks, models (generation / fast / embedding), LLM queue (pending, running, concurrency, average latency, circuit breaker), analysis & embedding cache hit rates, mailbox sync with **Sync now**, uptime, Kubernetes probe paths and the `/metrics` note. **Auto-refreshes every 15 s.** |
| `/settings`      | Organisation (name from `FeatureFlags.organizationName`, internal domains read-only from the policy, timezone, language), feature flags, health with *Re-check*, and a **Diagnostics** JSON export (health + flags + versions, no secrets). |
| `/audit`         | Search, the four contract filters plus **AI source** and **model** (read from `details.source` / `model`), page size and the server-side CSV export. |
| `/audit/[id]`    | Deep-linkable audit event: full field grid, AI `source`, SHA-256 prompt/response hashes, correlation id, **related events sharing the same correlation id**, raw JSON. |
| `/approvals`     | Escalations with the **draft under review** from the contract (`Escalation.draft`: subject, recipients, cc, attachments, sensitivity label). Optimistic decision + revalidation; **a rejection requires a comment**. The sidebar badge polls the pending count every 30 s. |
| `/automations`   | Owner filter (`?all=true` for the global admin view, `?user=<id>` for one owner), pause/resume via `PATCH { status }`, simulation checks with a pass counter, and no activation without a simulation. |
| `/policy`        | Versioned save (*updated by / at*), per-pattern regex validation in the browser with inline errors, and a **Rule test panel**: paste a sample body and recipients to see which rules would fire — clearly labelled *Preview*, evaluated client-side only. |
| `/analytics`     | Usage, performance, and **AI load** cards: model calls vs cache vs precomputed vs heuristic share and estimated GPU minutes saved, derived from `source` in the audit details (or `n/a` when the period carries none). |

## Environment

All variables are **server-side only** — no `NEXT_PUBLIC_*` exists, so no token ever
reaches the browser. `src/env.ts` validates them with zod at startup and fails fast.

| Variable                         | Default                    | Purpose                                                           |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `ORCHESTRATOR_URL`               | `http://localhost:8080`    | Base URL of the Fastify orchestrator (no trailing slash).          |
| `ADMIN_API_TOKEN`                | *(empty)*                  | Bearer used in `token` mode.                                       |
| `ADMIN_MOCK`                     | `false`                    | `true` → always use the mock dataset.                              |
| `ADMIN_AUTH_MODE`                | `token`                    | `aad` \| `token`.                                                  |
| `ADMIN_DEV_EMAIL`                | `admin@northbridge.example`| Identity in `token` mode (sent as `x-user-email`).                 |
| `ADMIN_DEV_NAME`                 | `Dashboard Operator`       | Display name in `token` mode.                                      |
| `ADMIN_DEV_ROLES`                | `admin`                    | Roles in `token` mode.                                             |
| `AUTH_SECRET`                    | *(required for `aad`)*     | Signs/encrypts the JWT session.                                    |
| `AUTH_URL`                       | *(optional)*               | Public URL, when it cannot be inferred.                            |
| `AUTH_MICROSOFT_ENTRA_ID_ID`     | *(required for `aad`)*     | Dashboard app registration id.                                     |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | *(required for `aad`)*     | Dashboard client secret.                                           |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | *(required for `aad`)*     | `https://login.microsoftonline.com/<tenant-id>/v2.0`.              |
| `ORCHESTRATOR_API_CLIENT_ID`     | *(required for `aad`)*     | API app id → scope `api://{id}/access_as_user`.                    |
| `ORCHESTRATOR_API_SCOPE`         | *(derived)*                | Full override of that scope.                                       |
| `ADMIN_SESSION_MAX_AGE`          | `3600`                     | JWT session lifetime, seconds.                                     |
| `ADMIN_EMAILS`                   | *(empty)*                  | Role fallback when no app role is assigned.                        |
| `COMPLIANCE_EMAILS`              | *(empty)*                  | Idem for the compliance role.                                      |
| `ADMIN_DEFAULT_LANGUAGE`         | `en`                       | `en` \| `fr`; overridden per browser by the `oao_lang` cookie.      |
| `ADMIN_TENANT_NAME`              | `Northbridge Capital`      | Fallback organisation label.                                       |
| `ADMIN_TZ`                       | `Europe/Zurich`            | IANA timezone used to render every date and time.                  |

## Security

* **CSP with a per-request nonce** — `src/middleware.ts` emits
  `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `'unsafe-inline'` for scripts;
  `'unsafe-inline'` is allowed for **styles** only, which Tailwind and Recharts need),
  `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`,
  `upgrade-insecure-requests`. It lives in the middleware because Next.js needs the
  nonce on the incoming request to stamp its inline bootstrap scripts.
* **Static headers** — `next.config.mjs` `headers()`: HSTS (2 years, preload),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a closed `Permissions-Policy`,
  COOP/CORP and `Cache-Control: no-store` (the dashboard renders audit data).
  `poweredByHeader: false`.
* **Defence in depth** — the middleware decides first, then every page calls
  `requireRoles()` and every route handler re-checks before touching the orchestrator.
* **Correlation ids** — each outbound call carries `x-correlation-id`; `ApiError.correlationId`
  is surfaced in the error toasts and on `/audit/[id]` so an operator can quote it.
* **No secrets client-side** — the diagnostics export contains only health, flags and
  versions; there is no `NEXT_PUBLIC_*` variable at all.

## Accessibility & i18n

* Skip link to `#main-content`, visible focus rings on every interactive element,
  `aria-label` on all icon-only buttons, `scope="col"` + `sr-only` captions on tables,
  scrollable table regions reachable with the keyboard, `aria-live` on the toasts and
  on the rule-preview results, `aria-invalid` + `role="alert"` on form errors.
* Every animation is behind `motion-safe:`, so `prefers-reduced-motion` disables it.
* Badge colours keep a ≥ 4.5:1 contrast ratio on their tinted backgrounds
  (`#107C10` on `#DFF6DD`, `#8A6D00` on `#FFF4CE`, `#C4314B` on `#FDE7E9`).
* **EN / FR** for every visible string (`src/lib/i18n.ts`, flat dictionary, strict key
  parity enforced by a test). Numbers and dates go through `Intl` with the operator's
  locale (`en-GB` / `fr-CH`) and the `ADMIN_TZ` timezone, passed from the server so the
  client renders exactly the same string.

## How data flows

* **Reads** — Server Components call `src/lib/api.ts`, which fetches the routes from
  `Routes` in `@oao/shared`, forwards the bearer + `Accept-Language` + `x-correlation-id`,
  and validates every payload with the shared zod schemas. All data pages are
  `dynamic = "force-dynamic"` and fetch with `cache: "no-store"`; pagination is
  server-side everywhere.
* **Writes** — the browser calls route handlers under `src/app/api/*`, which re-check
  the role, validate the body and proxy to the orchestrator (or the mock store):

  | Route handler                              | Target                                                                   |
  | ------------------------------------------ | ------------------------------------------------------------------------ |
  | `POST /api/escalations/[id]/decision`      | `POST Routes.escalationDecision(id)` (comment mandatory on a rejection)   |
  | `POST /api/automations/[id]/decision`      | `Routes.automationApprove/Reject(id)`, or `PATCH Routes.automation(id)` with `{ status }` for pause/resume |
  | `GET` · `PUT /api/policy`                  | `Routes.adminPolicy`, validated with `PolicySchema` + regex compilation   |
  | `GET /api/audit/export`                    | **streams** `Routes.auditExport` through with `Content-Disposition`; falls back to a locally built CSV |
  | `GET /api/system` · `POST /api/system/sync`| `Routes.adminSystem` · `Routes.mailboxSync`                              |
  | `GET /api/approvals/pending`               | `Routes.escalations` → pending count for the sidebar badge               |
  | `GET /api/health`                          | `Routes.health` + `Routes.features` (*Re-check*)                          |
  | `GET /api/diagnostics`                     | health + flags + versions as a JSON attachment                            |
  | `POST /api/language`                       | sets the `oao_lang` cookie                                               |
  | `GET /api/ping`                            | unauthenticated liveness probe (used by the e2e web server)              |

## Performance

* Server components by default; only interactive islands are client components.
* Recharts is loaded on demand (`src/components/charts/lazy.tsx`) — without it the
  overview alone would pay ~100 kB gz for charts that are not needed to read the KPIs.
* **First Load JS per route stays under 200 kB gz** (largest: `/` and `/policy` at
  182 kB, shared baseline 103 kB). `npm run analyze -w @oao/admin` regenerates the
  treemaps.

## Tests

* **77 Vitest unit tests** (`src/tests/`): role mapping from the `roles` claim and the
  email fallback, the route table and the middleware matcher, navigation visibility,
  the env schema (defaults + fail-fast), the CSP and the static headers of
  `next.config.mjs`, refresh-token rotation, policy regex validation (including the
  `(?i)` inline-flag translation), the rule preview evaluator, FR/EN key + placeholder
  parity, the CSV streaming export route, the error mapping of the route handlers, the
  AI-load derivation, formatting/timezones and the mock dataset.
* **12 Playwright e2e tests** (`e2e/`) against `next start` with `ADMIN_MOCK=true
  ADMIN_AUTH_MODE=token`, Chromium from `/opt/pw-browsers/chromium` (override with
  `PW_CHROMIUM_PATH`): the overview KPIs and charts, the audit deep link, the FR/EN
  toggle, the approvals decision flow (comment-required rejection, then approval),
  the policy save validation and rule preview, and the system page including *Sync now*.

## Mock data mode

Three ways the mock dataset is used:

1. **Forced** — `ADMIN_MOCK=true`.
2. **Automatic development fallback** — the orchestrator is probed (`GET /api/v1/health`,
   2.5 s timeout, cached 15 s). If it is unreachable or answers 5xx and
   `NODE_ENV !== "production"`, a warning is logged and the dataset takes over. In
   production the error propagates instead.
3. Either way a yellow **"Mock data"** pill appears in the top bar (hover for the reason).

The dataset (`src/lib/mock-data.ts`) is deterministic — a seeded `mulberry32` PRNG:
**1,247 audit events** over 12–18 May 2025 across 6 users of *Northbridge Capital*
(placeholder organisation, `northbridge.example`), KPIs pinned to the mock-up
(8,642 / 2,341 / 186 / 142 / 37 / 1,216), 3 automations, 4 escalations **with their
draft context**, the default policy, feature flags, a degraded health payload, a
`SystemStatus` (queue, caches, uptime) and a `MailboxSyncStatus`. Audit details carry
`source` (`llm` / `cache` / `precomputed` / `heuristic`) so the AI-load cards have data,
and correlation ids are shared in small groups so `/audit/[id]` shows related events.

Mutations in mock mode land in an in-memory store on `globalThis`, so approving an
escalation or pausing an automation is visible until the server restarts.

## Screenshots

`docs/screenshots/` — `overview`, `system`, `audit-detail`, `policy-test`, `approvals`,
`automations`, `policy` (`*.png` at 1440 px, `*-1024.png` at 1024 px), captured from a
production build in mock mode with `npm run screenshots -w @oao/admin`.

## Docker

`next.config.mjs` sets `output: "standalone"`, so the runtime image needs only the
`.next/standalone` bundle plus the static assets. The maintained Dockerfile lives in
`infra/docker/admin.Dockerfile` (used by `docker-compose.yml`):

```bash
docker build -f infra/docker/admin.Dockerfile -t oao-admin:0.1.0 .
docker run --rm -p 3001:3001 \
  -e ORCHESTRATOR_URL=http://orchestrator:8080 \
  -e ADMIN_AUTH_MODE=aad \
  -e AUTH_SECRET=... -e AUTH_URL=https://oao-admin.northbridge.example \
  -e AUTH_MICROSOFT_ENTRA_ID_ID=... -e AUTH_MICROSOFT_ENTRA_ID_SECRET=... \
  -e AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0 \
  -e ORCHESTRATOR_API_CLIENT_ID=... \
  oao-admin:0.1.0
```

`ADMIN_MOCK=true` at build time keeps the build from needing a live orchestrator;
every page is `force-dynamic`, so nothing is baked into the image.

## Notes on the contract

`@oao/shared` was **not** modified. What the dashboard would still like from it:

* **`GET /admin/users` filters** — `/automations` sends `?all=true` / `?userId=`, but
  `Automation` carries **no owner field**, so a per-user view cannot be rendered from a
  live orchestrator. Request: add `userId` (or `ownerId`) to `AutomationSchema`.
* **Pause / resume** — there is no dedicated route; the dashboard sends
  `PATCH Routes.automation(id)` with `{ status: "paused" | "active" }`
  (`AutomationPatchSchema` already allows it). Worth documenting as the official path.
* **Alerts** — no dedicated endpoint; `/alerts` is derived from the audit trail
  (`compliance_alert`, `compliance_escalated`, non-clean `phishing_check`).
* **`AuditEvent.details`** — the dashboard reads `source`, `promptSha256`,
  `responseSha256`, `policy`, `category` and `verdict` from the free-form `details`
  record. Promoting `source` to a first-class optional field of `AuditEvent` (it already
  exists on `EmailAnalysis`) would make the AI-load analytics reliable instead of
  best-effort.
* **`Routes.auditExport`** — the dashboard streams it through and expects `text/csv`;
  the contract does not describe its query parameters (it currently reuses `AuditQuery`).
* **`AuditQuery`** — `/audit` offers an **AI source** and a **model** filter; both are
  sent as `?source=` / `?model=` but are not in `AuditQuerySchema`, so an orchestrator
  that ignores them returns an unfiltered page (they are exact in mock mode). Request:
  add `source` and `model` to `AuditQuerySchema`.

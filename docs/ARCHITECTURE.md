# Outlook AI Orchestrator — Architecture

> Secure. Compliant. Human-in-the-loop.
> Northbridge Capital — internal AI competition. Tech Lead: Tech Lead. Product/PM: Product Owner.

## 1. Goal

An Outlook add-in (side panel) that lets a user **talk to their mailbox**: instant
summaries, decisions & tasks, risks, conversational search with cited sources,
thread synthesis, draft replies (never sent by the AI), proposed actions approved by
the user (human-in-the-loop), an **Automation Coach** (detect routines → propose →
simulate → activate) and a **Compliance Guardian** (pre-send checks + inbound
anti-phishing). Everything is audited and supervised from an admin dashboard.

The AI model is **hosted internally** (Northbridge GPU, Qwen3 today). The orchestrator
talks to it through an **OpenAI-compatible HTTP API** (vLLM, Ollama, LM Studio,
TGI, Azure OpenAI private tenant …). Switching model = changing environment variables.

## 2. Monorepo layout (npm workspaces, TypeScript everywhere)

```
outlook-ai-agent/
├── apps/
│   ├── addin/          # Outlook add-in  — React 18 + TypeScript + Vite + Office.js (Fluent UI v9)
│   ├── orchestrator/   # AI Orchestrator — Node 22 + Fastify 5 + PostgreSQL (pgvector) + zod
│   └── admin/          # Admin dashboard — Next.js (App Router) + Tailwind + shadcn/ui + Recharts
├── packages/
│   └── shared/         # @oao/shared — zod contracts + types + route table (single source of truth)
├── infra/
│   ├── docker/         # Dockerfiles, docker-compose (postgres+pgvector, orchestrator, admin, addin static)
│   └── k8s/            # Kubernetes manifests (Deployments, Services, Ingress, ConfigMap, Secret templates)
└── docs/               # Architecture, setup, actions catalogue, prompts, security, runbooks
```

Package names: `@oao/shared`, `@oao/orchestrator`, `@oao/addin`, `@oao/admin`.

**Package manager — npm workspaces only.** The root `package.json` declares
`"workspaces": ["packages/*", "apps/*"]` and `"packageManager": "npm@10.9.7"`;
npm 10 ships with Node 22, so Corepack (and anything asking for elevation on
Windows) is out of the picture. A single `package-lock.json` at the root pins
every workspace, `npm ci` reproduces it byte for byte in CI and in the images,
and `@oao/shared` is consumed as `"@oao/shared": "*"` — npm links it from
`node_modules/@oao/shared` to `packages/shared`.

**Two React majors in one tree.** The add-in is on React 18 (Fluent UI v9,
`@types/react@18`) and the dashboard on React 19 (Next 15). npm hoists one copy
to the root `node_modules` and nests the other:

| | hoisted at the repository root | nested under the workspace |
|---|---|---|
| runtime | `react`/`react-dom` **18** (add-in, Fluent UI, Testing Library) | `apps/admin/node_modules`: `next`, `next-auth`, `styled-jsx`, `react`/`react-dom` **19** |
| types | `@types/react` **18** | `apps/admin/node_modules/@types/react` **19** |

The nesting is not left to chance: the root `overrides` block declares that
`next` needs React 19 (`"next": { "react": "^19.0.0", "react-dom": "^19.0.0" }`),
which makes npm place Next and its React peer set inside `apps/admin`, where
Next resolves them — including from its own server-side code, which webpack
never rewrites. `apps/admin/tsconfig.json` pins `paths` *and* `typeRoots` to
that folder, and `apps/addin/react-resolution.ts` feeds Vite and Vitest an
alias + `dedupe` list resolved from the add-in's own manifest, so the task-pane
bundle contains exactly one React 18. Check with `npm ls react -w @oao/addin`.

## 3. Runtime topology

```
┌──────────────────────┐  HTTPS   ┌─────────────────────────────┐  HTTP(S)  ┌─────────────────────┐
│ Outlook (desktop/web)│ ───────► │ AI Orchestrator (Fastify)   │ ────────► │ Internal LLM        │
│  add-in task pane    │ ◄─────── │  /api/v1/*                  │ ◄──────── │ (OpenAI-compatible) │
│  React + Office.js   │          │  auth · policy · prompts ·  │           └─────────────────────┘
└──────────────────────┘          │  risk · actions · audit     │  OBO      ┌─────────────────────┐
         ▲                        │                             │ ────────► │ Microsoft Graph     │
         │ Office SSO token       │  PostgreSQL + pgvector      │           │ (optional, phase 2+)│
         │ (Azure AD)             └─────────────┬───────────────┘           └─────────────────────┘
┌────────┴─────────────┐                        │
│ Admin dashboard      │ ───────────────────────┘  /api/v1/audit, /automations, /compliance, /admin
│ Next.js + shadcn     │
└──────────────────────┘
```

**Two data paths for email content:**

1. **Office.js path (default, works day 1, no Graph permission needed).** The add-in
   reads the opened item (subject, from/to, body as text, attachment metadata, the
   conversation via `item.conversationId`) and POSTs it to the orchestrator.
2. **Graph path (optional, `GRAPH_ENABLED=true`).** The orchestrator exchanges the
   Office SSO token for a Graph token (On-Behalf-Of) and can fetch the whole
   conversation, index the mailbox, create tasks/reminders, apply categories, move
   messages. Minimal scopes: `Mail.Read` (phase 1), then `Mail.ReadWrite`,
   `Tasks.ReadWrite`, `Calendars.ReadWrite`.

**Actions have an execution target** (`client` | `server` | `none`, see contract):

| Action                | Target | How                                                   | Risk |
|-----------------------|--------|-------------------------------------------------------|------|
| draft_reply           | client | `item.displayReplyForm({htmlBody})` — never sent      | low  |
| categorize / flag     | client | `item.categories.addAsync`, `item.flag` (fallback: Graph) | low |
| archive / move_to_folder | server | Graph `move`; fallback → client instruction (open Move UI) | low |
| create_reminder       | server | Graph calendar event; fallback → client (`displayNewAppointmentForm`) | medium |
| create_task           | server | Graph To Do task; fallback → client (`displayNewAppointmentForm` as reminder) | medium |
| notify                | server | audit + optional internal webhook (`NOTIFY_WEBHOOK_URL`) | low |
| request_document      | client | opens a pre-filled reply draft                        | low  |
| escalate_compliance   | server | creates an Escalation (pending compliance decision)   | high |
| apply_label           | client | `item.sensitivityLabel` when available, else instruct user | low |
| remove_attachment     | client | `item.removeAttachmentAsync` (compose only)           | low  |

Governance (from the project dossier): summarise = automatic; draft = never sent;
categorise/tag/reminder = simple validation; automation = mandatory simulation;
send = never by the AI; delete = **out of scope** (not an action type); sensitive
attachment to external = alert / block / compliance validation.

## 4. Orchestrator internals (SOLID, ports & adapters)

```
apps/orchestrator/src/
├── server.ts / app.ts           # Fastify bootstrap, plugins, error handler, request-id
├── config.ts                    # zod-validated env
├── auth/                        # AuthPlugin: dev mode (headers) | aad mode (JWT via JWKS), roles
├── domain/                      # pure business logic, no I/O
│   ├── risk/                    # risk scoring, governance matrix (action → risk → approval)
│   ├── compliance/              # rules engine (external recipient, labels, patterns, phishing heuristics)
│   ├── automation/              # routine detection (pattern mining over UserActionEvents), simulation
│   └── prompts/                 # prompt builders + JSON output schemas (FR/EN)
├── ports/                       # interfaces: LlmProvider, EmbeddingProvider, AuditRepository, EmailIndexRepository,
│                                #   GraphClient, PolicyRepository, AutomationRepository, ActionRepository, EscalationRepository
├── adapters/
│   ├── llm/openai-compatible.ts # /v1/chat/completions (+ JSON mode), /v1/embeddings ; retries, timeouts
│   ├── llm/mock.ts              # deterministic provider for tests/demo (LLM_PROVIDER=mock)
│   ├── db/                      # pg pool, migrations runner (plain SQL files in /migrations), repositories
│   ├── graph/                   # Microsoft Graph client with OBO (msal-node), disabled when GRAPH_ENABLED=false
│   └── notify/                  # webhook notifier
├── services/                    # use cases: AnalyzeEmail, SynthesizeThread, DraftReply, Search, Chat, Index,
│                                #   ProposeActions, ApproveActions, ComplianceCheck, PhishingCheck, AutomationCoach, Audit, Policy
├── http/routes/                 # thin controllers: validate with @oao/shared schemas → service → response
└── migrations/                  # 0001_init.sql … (audit_events, email_index, chat_sessions, action_proposals,
                                 #   actions, escalations, automations, user_action_events, policies, feedback)
```

Rules:
- Controllers validate **every** request body with the shared zod schemas and return
  `ApiError` on failure (`400 validation_error`, `401 unauthorized`, `403 forbidden`,
  `404 not_found`, `409 conflict`, `500 database_error`, `502 llm_unavailable`, `503 graph_unavailable`).
- **Every** AI suggestion / action writes an `AuditEvent` (non-negotiable). The audit
  row stores structured details + SHA-256 hashes of prompt/response; raw email body is
  **not** stored unless `AUDIT_STORE_CONTENT=true`.
- LLM output is requested as JSON and validated with zod; on failure → one repair
  retry, then a safe degraded response (`confidence` lowered, `risks` include
  `ai_output_unreliable`).
- Fallback behaviour when the LLM is down: heuristics-only analysis (regex/rules)
  with `confidence ≤ 0.3` and an `error` audit event. When Graph is down: server
  actions return `pending_client` with a client instruction.
- Bilingual: detect the email language (FR/EN), answer in the user's language
  (`Accept-Language` or `language` field), prompts include the target language.

## 5. Add-in internals

```
apps/addin/
├── manifest/manifest.xml        # Classic XML manifest (Outlook desktop + web), MessageRead + MessageCompose,
│                                #   + SupportsPinning / SupportsNoItemContext / SupportsMultiSelect (list-level activation)
├── manifest/manifest.json       # Unified (Teams-app style) manifest for centralised M365 deployment
│                                #   + staticTabs (personal tab) = the "Apps" rail entry of the new Outlook / OWA
├── manifest/manifest.dev.*      # https://localhost:3000 variants for sideloading
├── scripts/manifest-template.mjs # Single source of truth for all four manifests (ADDIN_HOST/API_HOST/AAD_CLIENT_ID)
├── scripts/package-manifest.mjs  # Teams app package: zip(manifest.json + color.png + outline.png), pure zlib
├── scripts/icon-png.mjs          # shared icon rasteriser (public/assets/icon-*.png + the package icons)
├── src/
│   ├── taskpane/                # entry: taskpane.html + main.tsx (Office.onReady)
│   ├── commands/                # ribbon commands + ItemSend handler (Smart Alerts compliance check)
│   ├── app/                     # App shell: ReadMode, BriefMode, HomeMode, BackendUnreachable, Header, AppContext,
│   │                            #   ErrorBoundary, settings — the shell resolves the surface and re-resolves it on ItemChanged
│   ├── office/                  # Office.js adapters: readItem, readCompose, thread, actions, observe, sso, notifications,
│   │                            #   env (toStableEmailId, isPreviewMode/isTabHost), host (surface resolution),
│   │                            #   events (one ItemChanged/SelectedItemsChanged handler per pane), selection (multi-select)
│   ├── api/                     # typed client over @oao/shared Routes (fetch + zod + retry/backoff) · errors · mock · mockBrief
│   ├── cache/                   # idb.ts (IndexedDB wrapper) · analysisCache.ts (TTL, content-hash keys, pruning)
│   ├── net/                     # connectivity.ts (online/reachable) · outbox.ts (bounded queue for `observe` events)
│   ├── security/                # csp.ts (build-time CSP + frameAncestors for the static host) · sanitize.ts
│   ├── telemetry.ts             # fetch-beacon sink, never carries email content; no-op when VITE_TELEMETRY_URL is unset
│   ├── features/
│   │   ├── summary/             # Summary tab + TriageCard + useAnalysis (three-tier fetch: cache → precomputed → model)
│   │   ├── brief/               # DailyBriefView (GET /brief/daily, POST to refresh)
│   │   ├── chat/                # Chat tab (question → answer + Sources used + Evidence + "Open original email")
│   │   ├── thread/              # Thread synthesis view (also renders a multi-selection synthesis)
│   │   ├── selection/           # Selection view: N selected messages → synthesise / ask / propose actions
│   │   ├── actions/             # Action approval dialog + actionRunner (client-side execution of approved actions)
│   │   ├── automation/          # Automation Coach (detected steps, simulation, Approve / Edit rule)
│   │   ├── compliance/          # Compliance Guardian (compose mode) — also the Smart Alerts path
│   │   ├── insights/            # Insights tab + SyncStatusPill (mailbox sync state)
│   │   ├── settings/            # SettingsSheet (language, précalcul, clear local cache)
│   │   └── lazy.ts              # code-split entry points (one chunk per tab)
│   ├── i18n/                    # fr.json, en.json + provider
│   ├── util/hash.ts             # content hashing used by the local cache keys
│   └── ui/                      # shared components (ConfidenceBar, RiskBadge, SectionCard, SourceBadge, States, toast, theme)
└── vite.config.ts               # https dev server on 3000, CSP meta injection, hidden source maps
```

**Five surfaces, one page** (`src/office/host.ts`) — `taskpane.html` renders
`compose`, `read`, `selection`, `brief` or `home` depending on the host and on
what is selected. The synchronous guess is refined once by
`getSelectedItemsAsync` (Mailbox 1.13), because "no item" means *either* nothing
selected *or* a multi-selection, and re-resolved on every `ItemChanged` /
`SelectedItemsChanged` — a pinned pane follows the message list for its whole
lifetime, so surface detection cannot be a one-shot decision. A multi-selection
gets a synthetic `conversationId` (`selection:<hash of the sorted item ids>`)
which keys its `analyzeThread` cache entry and scopes its chat retrieval after
the selected messages have been indexed.

`home` is the surface with **no item**: the unified manifest's personal tab in
the Apps rail (`?view=home&host=tab`, where there is no `Office.context.mailbox`
at all) and the pinned pane with nothing selected. Brief + chat + sync status
only, every `Office.*` call guarded. It is deliberately **not** the browser "preview"
mode — preview is dev-only and shows the sample email, home talks to the real
backend, and `decideApi()` (`src/api/index.ts`) never substitutes mock data for a
real mailbox: inside any Outlook host a failed health check blocks the pane with
the base URL, the error and a Retry.

**Three-tier analysis** (`features/summary/useAnalysis.ts`) — the pane never
calls the model when it can avoid it:

1. IndexedDB cache, key `analysis:<hash(itemId)>:<contentHash+lang>`, TTL 24 h;
2. `GET /api/v1/analyze/email/:emailId` — precomputed or server-cached, one
   cheap GET, never a model call, `404` when nothing exists yet;
3. `POST /api/v1/analyze/email` — the only tier that can reach the GPU.

Every tier is labelled in the UI (*From cache* / *Precomputed* / *Rules only* /
model) so the user always knows where the answer comes from.

**Static hosting requirements** (enforced by `infra/docker/nginx.conf`):
`frame-ancestors` can only be sent as an HTTP header — `frameAncestors()` in
`src/security/csp.ts` returns the exact value; `assets/*` are content-hashed and
served `public, max-age=31536000, immutable`; `taskpane.html`, `commands.html`,
`commands.js` and `manifest/*` are `no-cache`; `*.map` must return **404**
(the maps are built hidden and belong in the error tracker, not on the web).

UI reference = the mock-ups in `docs/mockups.md` (Fluent-like, white cards, blue
accent `#0F6CBD`, risk badges green/orange/red, "AI confidence" bar, "AI-generated
content may be incorrect" footer with thumbs up/down).

## 6. Admin dashboard (Next.js + shadcn)

App Router, `output: "standalone"`, server-side only (no `NEXT_PUBLIC_*`: no
token ever reaches the browser).

| Route group | Pages |
|---|---|
| `(dashboard)` | `/` Overview (KPIs + charts), `/audit` (filters + CSV export), `/audit/[id]` (full event detail: prompt/response hashes, model, latency, correlationId), `/approvals`, `/alerts`, `/automations`, `/policy` (edit `Policy` + **policy test panel**), `/system` (runtime status), `/analytics`, `/integrations`, `/roles`, `/users`, `/settings` |
| `(public)` | `/signin` (Entra ID button), `/no-access` (authenticated but no role) |
| `api/*` | `auth/[...nextauth]`, `audit/export` (streamed CSV proxy), `system`, `system/sync`, `policy`, `approvals/pending`, `escalations/[id]/decision`, `automations/[id]/decision`, `diagnostics`, `health`, `ping`, `language` |

- **Authentication** — `ADMIN_AUTH_MODE=aad` uses **Auth.js v5 (next-auth)** with
  the Microsoft Entra ID provider (`src/auth.ts`). Sign-in requests
  `api://{ORCHESTRATOR_API_CLIENT_ID}/access_as_user`, so the JWT session carries
  an **access token for the orchestrator**, not just an id token; refresh-token
  rotation happens ~60 s before expiry (`src/lib/entra.ts`). `ADMIN_AUTH_MODE=token`
  keeps the shared `ADMIN_API_TOKEN` + dev headers for local work, e2e and demos.
- **RBAC** — `src/lib/rbac.ts`: roles come from the `roles` claim of the access
  token, with `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` as fallback. `src/middleware.ts`
  gates every route group and redirects to `/no-access` rather than 404-ing.
- **`/system`** — live view of `GET /api/v1/admin/system`: LLM queue depth and
  circuit state, analysis/embedding cache counters, mailbox sync state, uptime,
  feature flags.
- **`/audit/[id]`** — one event, fully expanded, with the same redaction rules as
  the API (hashes unless `AUDIT_STORE_CONTENT=true`).
- **Policy test panel** — `components/policy/policy-test-panel.tsx` runs a draft
  against the *edited, unsaved* policy (`src/lib/policy-preview.ts`) so a
  compliance officer sees what a pattern change would flag before saving it.
- **CSP** — `src/middleware.ts` emits a per-request **nonce** CSP; the static
  headers live in `next.config.mjs` (see §7 and `docs/SECURITY.md`).

## 7. Security

- Add-in ↔ orchestrator: HTTPS, bearer token. `AUTH_MODE=aad` validates Azure AD JWT
  (issuer/audience/JWKS, `AAD_REQUIRE_SCOPE`, `AAD_CLOCK_SKEW_SECONDS`).
  `AUTH_MODE=dev` accepts `x-user-email` / `x-user-name` headers (local only,
  refused when `NODE_ENV=production`).
- Roles: `user`, `compliance`, `admin` (from Entra ID app roles or `ADMIN_EMAILS` /
  `COMPLIANCE_EMAILS`).
- No secrets in the repo; `.env.example` only. In Kubernetes every secret is
  mounted as a **file** and read through `<NAME>_FILE` (`secrets.mountAsFiles`),
  so nothing sensitive appears in the pod environment.
- Data minimisation: only the fields in `EmailContext` are sent; audit stores
  SHA-256 hashes unless `AUDIT_STORE_CONTENT=true`.
- Per-user scoping: every repository query is filtered by `user.id`; only
  `admin`/`compliance` may widen it (audit, escalations, another user's sync).
- `Idempotency-Key` on `POST /actions/approve`: a retried approval replays the
  stored response instead of executing twice (`IDEMPOTENCY_TTL_HOURS`).
- Rate limiting (`RATE_LIMIT_PER_MINUTE`, honest client IP via `TRUST_PROXY`),
  body limit (`BODY_LIMIT_BYTES`), CORS restricted to the add-in origin, Helmet.
- Tenant isolation: `AAD_TENANT_ID` (plus `AAD_ALLOWED_TENANTS` when explicitly
  configured); `user.tenantId` is checked on every request.

## 8. Configuration

Three schemas, three files — each app validates its own environment at startup
and fails fast with the **complete** list of problems:

| App | Schema | Reference |
|---|---|---|
| Orchestrator | `apps/orchestrator/src/config.ts` (zod) | `.env.example` (root) |
| Add-in (build-time only) | `apps/addin/vite.config.ts` + `src/api/client.ts` | `apps/addin/.env.example` |
| Admin dashboard | `apps/admin/src/env.ts` (zod) | `apps/admin/.env.example` |

In production none of these `.env` files is the configuration mechanism: the
Helm chart renders the orchestrator ConfigMap from `infra/helm/.../values.yaml`
and the secrets from the Secret/ExternalSecret templates.

### 8.1 Orchestrator — full list

Every variable has a safe default; `LLM_PROVIDER=mock DATABASE_URL=memory` runs
with no external dependency. Any `FOO_FILE=/path` is read at boot and fills `FOO`.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `ROLE` | `api` | `api` (HTTP only) \| `worker` (jobs only, **no HTTP listener**) \| `all` |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP listener |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | pino |
| `ORGANIZATION_NAME` | `Northbridge Capital` | surfaced in `FeatureFlags.organizationName` |
| **`LLM_PROVIDER`** | `openai-compatible` | `openai-compatible` \| `mock` |
| **`LLM_BASE_URL`** | `http://localhost:8000/v1` | **operator must set** — internal endpoint |
| **`LLM_API_KEY`** | — | **operator must set** when the endpoint requires one (`LLM_API_KEY_FILE`) |
| **`LLM_MODEL`** | `qwen3-30b-a3b` | **operator must set** — must match `--served-model-name` |
| **`LLM_FAST_MODEL`** | — | **operator must set** — small model for triage-assist, classification, phishing, extraction |
| `LLM_TIMEOUT_MS` / `LLM_MAX_TOKENS` | `60000` / `2048` | per-call budget |
| `LLM_JSON_MODE` | `auto` | `auto` \| `response_format` \| `prompt` |
| `LLM_CONCURRENCY` | `4` | global in-flight model calls |
| `LLM_QUEUE_TIMEOUT_MS` | `30000` | max wait for a slot |
| `LLM_CIRCUIT_FAILURES` / `LLM_CIRCUIT_COOLDOWN_MS` | `5` / `30000` | circuit breaker |
| `LLM_INPUT_MAX_CHARS` | `12000` | hard cap on body text sent to the model |
| `THREAD_MAX_MESSAGES` | `12` | messages kept verbatim in a thread prompt |
| `PROMPT_VERSION` | `2026-09-v2` | part of every cache key — bump on prompt change |
| `EMBEDDINGS_ENABLED` | `true` | pgvector semantic search |
| **`EMBEDDING_MODEL`** | `bge-m3` | **operator must set** |
| **`EMBEDDING_DIMENSIONS`** | `1024` | **operator must set** — must equal the `vector(N)` column |
| `EMBEDDING_BATCH_SIZE` | `64` | texts per `/embeddings` call |
| `TRIAGE_ENABLED` | `true` | heuristic triage before any model call |
| `ANALYSIS_CACHE_ENABLED` / `ANALYSIS_CACHE_TTL_HOURS` | `true` / `168` | content-hash cache |
| `EMBEDDING_CACHE_ENABLED` / `EMBEDDING_CACHE_TTL_DAYS` | `true` / `365` | vector cache |
| `DATABASE_URL` | `postgres://oao:oao@localhost:5432/oao` | or `memory` (`DATABASE_URL_FILE`) |
| `DB_AUTO_MIGRATE` | `true` | keep `false` in production (the chart runs a Job) |
| `DB_POOL_MIN` / `DB_POOL_MAX` | `0` / `10` | pg pool |
| `DB_STATEMENT_TIMEOUT_MS` / `DB_IDLE_TIMEOUT_MS` / `DB_CONNECTION_TIMEOUT_MS` | `15000` / `30000` / `5000` | pg guards |
| `DEMO_SEED` | `true` | **never** `true` in production |
| `AUTH_MODE` | `dev` | `dev` (refused when `NODE_ENV=production`) \| `aad` |
| `AAD_TENANT_ID` / `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` | — | required by `AUTH_MODE=aad` / `GRAPH_ENABLED` |
| `AAD_ALLOWED_TENANTS` | — | extra accepted tenants |
| `AAD_REQUIRE_SCOPE` | — | e.g. `access_as_user` |
| `AAD_CLOCK_SKEW_SECONDS` | `60` | JWT `exp`/`nbf` tolerance |
| `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` | `admin@…` / `compliance@…` | role fallback |
| `ADMIN_API_TOKEN` | `change-me` | ≥ 24 chars in production (`ADMIN_API_TOKEN_FILE`) |
| `GRAPH_ENABLED` | `false` | Microsoft Graph access |
| `GRAPH_AUTH_MODE` | `obo` | `obo` (delegated) \| `app` (application permissions + Exchange policy) |
| `PRECOMPUTE_ENABLED` | `false` | background analysis of synced mailboxes |
| `WORKERS_ENABLED` | `true` | master switch for the scheduler (independent of `ROLE`) |
| `SYNC_INTERVAL_MINUTES` / `SYNC_MAX_MESSAGES_PER_RUN` | `10` / `100` | sync budget |
| `SYNC_USERS` / `SYNC_GROUP_ID` | — | mailbox scope in `GRAPH_AUTH_MODE=app` (one of the two is required) |
| `DAILY_BRIEF_ENABLED` / `DAILY_BRIEF_HOUR` | `true` / `7` | 0–23, in `TZ` |
| `TZ` | `UTC` | IANA timezone of the scheduler and of brief dates |
| `AUDIT_RETENTION_DAYS` / `INDEX_RETENTION_DAYS` | `730` / `365` | applied by the retention job |
| `IDEMPOTENCY_TTL_HOURS` | `24` | lifetime of an `Idempotency-Key` record |
| `AUDIT_STORE_CONTENT` | `false` | `true` stores raw bodies — compliance sign-off |
| `CORS_ORIGINS` | `https://localhost:3000` | the add-in origin |
| `RATE_LIMIT_PER_MINUTE` | `120` | per user/IP |
| `TRUST_PROXY` | `true` | `true`/`false`, a hop count, or an IP/CIDR list |
| `REQUEST_TIMEOUT_MS` / `BODY_LIMIT_BYTES` / `SHUTDOWN_TIMEOUT_MS` | `30000` / `2 MiB` / `25000` | transport |
| `METRICS_ENABLED` / `METRICS_TOKEN` | `true` / — | `GET /metrics`, bearer-protected when set (`METRICS_TOKEN_FILE`) |
| `API_DOCS_ENABLED` | `false` | Swagger UI — keep `false` in production |
| `NOTIFY_WEBHOOK_URL` | — | internal webhook for the `notify` action |
| `DEFAULT_LANGUAGE` | `fr` | `fr` \| `en` |
| `INTERNAL_DOMAINS` | `northbridge.example` | overrides `DEFAULT_POLICY.internalDomains` |

### 8.2 Add-in — build-time variables

`VITE_API_BASE_URL` (the **origin** only: `Routes.*` already carry `/api/v1`, and
this value is also baked into the CSP `connect-src`), `VITE_API_MOCK`,
`VITE_AUTH_MODE`, `VITE_ADMIN_URL`, `VITE_COMPLIANCE_EMAIL`,
`VITE_ONSEND_FAIL_MODE` (`open` = an on-send compliance check that itself fails
does not block the send; `closed` = the send is refused until it works), and the
optional `VITE_TELEMETRY_URL` / `VITE_APPINSIGHTS_*`. The manifest renderer reads
`ADDIN_HOST`, `API_HOST`, `AAD_CLIENT_ID`, `ADDIN_ID`, `ADDIN_VERSION`,
`ORGANIZATION_NAME`.

### 8.3 Admin dashboard

`ORCHESTRATOR_URL`, `ADMIN_API_TOKEN`, `ADMIN_MOCK`, `ADMIN_AUTH_MODE`,
`ADMIN_DEFAULT_LANGUAGE`, `ADMIN_TENANT_NAME`, `ADMIN_TZ`,
`ADMIN_SESSION_MAX_AGE`, `ADMIN_EMAILS`, `COMPLIANCE_EMAILS`,
`ADMIN_DEV_EMAIL`/`_NAME`/`_ROLES`, and — required in `aad` mode — `AUTH_SECRET`,
`AUTH_URL`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`,
`AUTH_MICROSOFT_ENTRA_ID_ISSUER`, plus `ORCHESTRATOR_API_CLIENT_ID` (or
`ORCHESTRATOR_API_SCOPE`).

### 8.4 Minimisation de la charge IA

> Résumé de `apps/orchestrator/docs/AI_LOAD.md`, qui reste la référence.

Le principe : **le meilleur appel au modèle est celui qu'on ne fait pas**. Sept
leviers, du moins cher au plus cher :

| # | Levier | Où | Effet |
|---|---|---|---|
| 1 | Triage heuristique (`TRIAGE_ENABLED`) | `domain/triage.ts` | 40–60 % des emails (newsletters, notifications, absences, accusés de réception) ne déclenchent **aucun** appel modèle |
| 2 | Slimming du prompt (`LLM_INPUT_MAX_CHARS`, `THREAD_MAX_MESSAGES`) | `domain/prompts/clean.ts` | −60 à −90 % de tokens d'entrée sur un fil |
| 3 | Cache par hash de contenu (`ANALYSIS_CACHE_*`, `PROMPT_VERSION`) | `services/AiCacheService.ts` | 0 appel pour un contenu déjà analysé |
| 4 | Coalescing | `util/coalesce.ts` | les requêtes identiques simultanées partagent un seul appel |
| 5 | Précalcul (`PRECOMPUTE_ENABLED` + sync mailbox) | `workers/mailboxSync.ts` | l'analyse est déjà faite quand l'utilisateur ouvre Outlook |
| 6 | Routage deux niveaux (`LLM_FAST_MODEL`) | `adapters/llm/queue.ts` | les tâches structurées partent sur un petit modèle |
| 7 | Cache d'embeddings (`EMBEDDING_CACHE_*`) | `embedding_cache` | ré-indexer une boîte ne ré-embedde jamais le texte inchangé |

Deux garde-fous complètent le dispositif :

- **file d'attente bornée** — `LLM_CONCURRENCY` appels simultanés, priorités
  (`interactive` > `background`), `LLM_QUEUE_TIMEOUT_MS` ;
- **circuit breaker** — `LLM_CIRCUIT_FAILURES` échecs consécutifs ouvrent le
  circuit pendant `LLM_CIRCUIT_COOLDOWN_MS` ; le produit bascule immédiatement
  en repli heuristique (confiance honnêtement basse) plutôt que d'attendre.

Côté client, l'add-in ajoute un cache IndexedDB de 24 h et le tier
`GET /analyze/email/:id` (§5), qui ne touche jamais le modèle.

Mesure : `oao_model_calls_saved_total{reason}` (triage / cache / precomputed /
coalesced) rapporté à `oao_llm_calls_total` donne le taux d'évitement réel ;
`oao_triage_total{kind,skipped}` détaille le levier 1.

## 9. Phases mapping (dossier §9–12)

| Phase | Features                                                                          | Where |
|-------|-----------------------------------------------------------------------------------|-------|
| 1     | Summary/decisions/tasks/risks, draft reply (not sent), audit log, add-in scaffold  | done in this repo |
| 2     | Validated actions (HITL), conversational search, thread synthesis                 | done in this repo |
| 3     | Multi-email chat, auto-categorisation, Automation Coach + simulation              | done in this repo |
| 4     | Pre-send compliance checks, attachment analysis (text), anti-phishing, dashboard  | done in this repo |

## 10. Déploiement NKP

> Cette section décrit la **topologie de déploiement** (comment le système est
> packagé et exécuté), pas les internes applicatifs. Procédure pas-à-pas :
> [`NKP.md`](NKP.md) · Exploitation : [`OPERATIONS.md`](OPERATIONS.md).

### 10.1 Un processus, deux rôles

Le même binaire (`apps/orchestrator/dist/server.js`, la même image) sert deux
rôles, sélectionnés par la variable `ROLE` :

| `ROLE` | Ce qui tourne | Écoute HTTP ? | Réplicas | Pourquoi |
|---|---|---|---|---|
| `api` | serveur HTTP `/api/v1/*`, `/metrics` | oui | 2 → 6 (HPA) | sans état, scalable horizontalement |
| `worker` | mailbox sync (Graph), précalcul, daily brief, rétention | **non** | **1** | un seul ordonnanceur ; élection de leader par advisory lock PostgreSQL |
| `all` | les deux | oui | 1 | dev, démo, Docker mono-machine, **et le pod worker du chart** |

`servesApi()` (`apps/orchestrator/src/config.ts`) n'est vrai que pour `api` et
`all` : avec `ROLE=worker` le processus **n'ouvre aucun port**, donc ni probe
HTTP ni scrape `/metrics`. Or `oao_mailbox_sync_lag_seconds` et
`oao_llm_queue_depth` du worker n'existent que là. Le chart déploie donc le pod
worker en `ROLE=all` par défaut (`orchestrator.worker.role`), avec
`WORKERS_ENABLED=true` et **sans route Ingress** : seuls les probes kubelet et
le namespace de monitoring l'atteignent. Mettre `orchestrator.worker.role=worker`
reste possible ; le chart supprime alors les probes, le Service et l'endpoint du
ServiceMonitor, et l'alerte `OaoWorkerAbsent` ne peut plus se déclencher.

Le pod `api` reçoit `WORKERS_ENABLED=false` : `runsWorkers()` exige déjà
`ROLE ∈ {worker, all}`, mais la séparation est ainsi lisible dans le pod spec.

Séparer les deux rôles évite qu'un pic de trafic interactif (volet Outlook)
n'entre en concurrence avec les jobs de fond pour les appels au GPU, et permet
de redémarrer l'API sans interrompre un cycle de synchronisation.

### 10.2 Topologie en cluster

```
                    Internet / LAN Northbridge
                              │  (DNS -> VIP Traefik)
        ┌─────────────────────┴──────────────────────┐
        │             Traefik (ns kommander)         │   TLS cert-manager
        └───┬──────────────┬─────────────────────┬───┘   (PKI interne)
            │ api.         │ admin.              │ addin.
  ┌─────────▼────────┐ ┌───▼──────────┐ ┌────────▼─────────┐
  │ oao-api  ×2      │ │ oao-admin ×1 │ │ oao-addin ×2     │  TLS terminé
  │ ROLE=api  8080   │ │ Next.js 3001 │ │ nginx 3000 (TLS) │  dans le pod
  │ HPA + PDB        │ └───┬──────────┘ └──────────────────┘
  └───┬────────┬─────┘     │ (server-side)
      │        └───────────┘
      │  ┌──────────────────┐        ┌───────────────────────────┐
      ├─►│ oao-worker ×1    │───────►│ Microsoft Graph / Entra ID│ (443, si activé)
      │  │ ROLE=all (jobs)  │        └───────────────────────────┘
      │  └────────┬─────────┘
      │           │           ┌────────────────────────────┐
      ├───────────┴──────────►│ LLM interne (vLLM, Qwen3)  │ (CIDR déclaré)
      │                       └────────────────────────────┘
  ┌───▼──────────────────┐
  │ oao-postgres (STS)   │  PVC nutanix-volume 20Gi
  │ PostgreSQL + pgvector│  CronJob pg_dump quotidien
  └──────────────────────┘

  Hooks : Job oao-migrate (pre-install / pre-upgrade)
  Observabilité : ServiceMonitor + PrometheusRule + dashboard Grafana
  Réseau : NetworkPolicy default-deny + 8 politiques explicites
```

### 10.3 Packaging et livraison

- **Source unique de vérité** : le chart Helm
  `infra/helm/outlook-ai-orchestrator`. `infra/k8s/rendered/` n'en est qu'une
  projection générée (`npm run k8s:render`) pour les environnements sans Helm.
- **Trois images**, construites depuis la racine du monorepo, non-root et
  compatibles `readOnlyRootFilesystem` :
  `oao-orchestrator` (API + worker + migrations), `oao-admin`, `oao-addin`.
  Le bundle Vite **et** les manifests Office de l'add-in sont figés au build :
  ce sont des artefacts de version, donc une image add-in par environnement.
- **GitOps** : Flux (fourni par Kommander) applique un `HelmRelease` par
  environnement (`infra/gitops/envs/{dev,prod}`), la production suivant les
  tags git via `ref.semver`. Les secrets arrivent chiffrés (SOPS/age) ou par
  External Secrets Operator ; ils sont **montés en fichiers** et lus par
  l'orchestrator via `<NOM>_FILE`.
- **Chaîne d'approvisionnement** : images et chart signés (cosign keyless),
  SBOM attestée, scan trivy bloquant sur `CRITICAL`, vérification possible à
  l'admission (Kyverno) — voir [`SECURITY.md`](SECURITY.md) §13.

### 10.4 Conséquences architecturales

Ce que le déploiement impose au code applicatif — et qui explique certains
choix visibles dans `apps/orchestrator` :

| Contrainte de déploiement | Implication dans l'application |
|---|---|
| Probes Kubernetes distinctes | `/api/v1/live` (processus vivant) et `/api/v1/ready` (dépendances) doivent avoir des sémantiques différentes : un LLM en panne ne doit pas provoquer un redémarrage en boucle |
| Rootfs en lecture seule | aucun fichier temporaire hors `/tmp` ; pas d'écriture de cache sur disque |
| Secrets montés en fichiers | support de `<NOM>_FILE` pour toute variable sensible, résolu une fois au démarrage |
| Plusieurs répliques d'API | aucun état en mémoire de processus qui ne soit reconstructible ; les caches sont des optimisations, pas des sources de vérité |
| Un seul worker | les jobs de fond prennent un advisory lock PostgreSQL plutôt que de supposer l'unicité |
| Arrêt propre (rolling update) | `SHUTDOWN_TIMEOUT_MS` : fin des requêtes en cours, fermeture du pool, libération du verrou |
| Migrations en hook `pre-upgrade` | les migrations doivent être rétro-compatibles avec la version N-1 le temps du rollout |
| NetworkPolicy default-deny | toute nouvelle dépendance sortante est une décision d'architecture, à déclarer explicitement dans les values |
| Scrape Prometheus | `/metrics` protégé par `METRICS_TOKEN`, noms de métriques stables (contrat listé dans [`OPERATIONS.md`](OPERATIONS.md) §3) |

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

## 2. Monorepo layout (pnpm workspaces, TypeScript everywhere)

```
outlook-ai-agent/
├── apps/
│   ├── addin/          # Outlook add-in  — React 18 + TypeScript + Vite + Office.js (Fluent UI v9)
│   ├── orchestrator/   # AI Orchestrator — Node 20 + Fastify 5 + PostgreSQL (pgvector) + zod
│   └── admin/          # Admin dashboard — Next.js (App Router) + Tailwind + shadcn/ui + Recharts
├── packages/
│   └── shared/         # @oao/shared — zod contracts + types + route table (single source of truth)
├── infra/
│   ├── docker/         # Dockerfiles, docker-compose (postgres+pgvector, orchestrator, admin, addin static)
│   └── k8s/            # Kubernetes manifests (Deployments, Services, Ingress, ConfigMap, Secret templates)
└── docs/               # Architecture, setup, actions catalogue, prompts, security, runbooks
```

Package names: `@oao/shared`, `@oao/orchestrator`, `@oao/addin`, `@oao/admin`.

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
  `404 not_found`, `409 conflict`, `502 llm_unavailable`, `503 graph_unavailable`).
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
├── manifest/manifest.xml        # Classic XML manifest (Outlook desktop + web), MessageRead + MessageCompose
├── manifest/manifest.dev.xml    # localhost:3000 (https) variant for sideloading
├── src/
│   ├── taskpane/                # entry: index.html + main.tsx (Office.onReady)
│   ├── commands/                # ribbon commands (open pane, run compliance check on send — ItemSend event)
│   ├── office/                  # Office.js adapters: readCurrentItem(), readCompose(), executeClientAction(), sso.ts
│   ├── api/                     # typed client over @oao/shared Routes (fetch, auth header, error mapping)
│   ├── features/
│   │   ├── summary/             # Summary tab (summary, decisions, pending tasks, risks, suggested actions, confidence)
│   │   ├── chat/                # Chat tab (question → answer + Sources used + Evidence + "Open original email")
│   │   ├── thread/              # Thread synthesis view (executive summary, missing document banner, open tasks, deadlines, risks)
│   │   ├── actions/             # Action approval dialog (table: action / explanation / source / risk / select) + "Approve selected (n)"
│   │   ├── automation/          # Automation Coach (detected workflow steps, simulation card, Run simulation / Edit rule / Approve)
│   │   └── compliance/          # Compliance Guardian (compose mode): issues list, recommended actions, confidence
│   ├── i18n/                    # fr.json, en.json (+ hook)
│   └── ui/                      # shared components (ConfidenceBar, RiskBadge, Card, Tabs, feedback thumbs)
└── vite.config.ts               # https dev server on 3000 (office-addin-dev-certs), base './'
```

UI reference = the mock-ups in `docs/mockups.md` (Fluent-like, white cards, blue
accent `#0F6CBD`, risk badges green/orange/red, "AI confidence" bar, "AI-generated
content may be incorrect" footer with thumbs up/down).

## 6. Admin dashboard (Next.js + shadcn)

Pages: `/` Overview (KPIs + charts), `/audit` (audit log table with filters, details drawer,
export CSV), `/approvals` (pending compliance escalations, approve/reject), `/alerts`,
`/automations`, `/policy` (edit `Policy`), `/users`, `/settings`. Server-side fetch to the
orchestrator with an admin bearer token (`ADMIN_API_TOKEN`, dev) or AAD (prod).

## 7. Security

- Add-in ↔ orchestrator: HTTPS, bearer token. `AUTH_MODE=aad` validates Azure AD JWT
  (issuer/audience/JWKS). `AUTH_MODE=dev` accepts `x-user-email` / `x-user-name` headers
  (local only, refused when `NODE_ENV=production`).
- Roles: `user`, `compliance`, `admin` (from AAD app roles/groups or `ADMIN_EMAILS` /
  `COMPLIANCE_EMAILS` env in dev).
- No secrets in the repo; `.env.example` only. K8s secrets templated.
- Data minimisation: only the fields in `EmailContext` are sent; audit stores hashes.
- Rate limiting, request size limit (2 MB), CORS restricted to the add-in origin, Helmet.
- Tenant isolation: `TENANT_ID` pinned; `user.tenantId` checked.

## 8. Configuration (single `.env` — this is what Northbridge configures)

```
# --- AI model (OpenAI-compatible endpoint hosted internally) ---
LLM_PROVIDER=openai-compatible        # openai-compatible | mock
LLM_BASE_URL=http://gpu-node.northbridge.local:8000/v1
LLM_API_KEY=                          # optional
LLM_MODEL=qwen3-30b-a3b
LLM_TIMEOUT_MS=60000
LLM_MAX_TOKENS=2048
LLM_JSON_MODE=auto                    # auto | response_format | prompt (how to force JSON)
EMBEDDINGS_ENABLED=true
EMBEDDING_MODEL=bge-m3                # served on the same endpoint (/v1/embeddings)
EMBEDDING_DIMENSIONS=1024

# --- Database ---
DATABASE_URL=postgres://oao:oao@localhost:5432/oao

# --- Auth ---
AUTH_MODE=dev                         # dev | aad
AAD_TENANT_ID=
AAD_CLIENT_ID=                        # add-in app registration (audience)
AAD_CLIENT_SECRET=                    # for OBO to Graph
ADMIN_EMAILS=admin@northbridge.example
COMPLIANCE_EMAILS=compliance@northbridge.example
ADMIN_API_TOKEN=change-me             # used by the admin dashboard in dev

# --- Microsoft Graph (optional) ---
GRAPH_ENABLED=false

# --- Misc ---
PORT=8080
CORS_ORIGINS=https://localhost:3000
AUDIT_STORE_CONTENT=false
NOTIFY_WEBHOOK_URL=
DEFAULT_LANGUAGE=fr
```

## 9. Phases mapping (dossier §9–12)

| Phase | Features                                                                          | Where |
|-------|-----------------------------------------------------------------------------------|-------|
| 1     | Summary/decisions/tasks/risks, draft reply (not sent), audit log, add-in scaffold  | done in this repo |
| 2     | Validated actions (HITL), conversational search, thread synthesis                 | done in this repo |
| 3     | Multi-email chat, auto-categorisation, Automation Coach + simulation              | done in this repo |
| 4     | Pre-send compliance checks, attachment analysis (text), anti-phishing, dashboard  | done in this repo |

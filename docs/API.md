# API — Outlook AI Orchestrator

> Toutes les routes sont définies dans `packages/shared/src/index.ts`
> (`Routes`, préfixe `API_PREFIX = /api/v1`) — source unique de vérité des
> chemins, consommée telle quelle par l'add-in et le dashboard admin. Les noms
> de schéma renvoient aux exports zod du même fichier. Le rôle requis suit le
> RBAC documenté dans `docs/SECURITY.md` §5 ; `user` est le niveau minimal
> (toute route `user` est aussi accessible à `compliance` et `admin`).
>
> Authentification : header `Authorization: Bearer <token>` (`AUTH_MODE=aad`,
> JWT Azure AD) ou, en dev uniquement, `x-user-email` / `x-user-name`
> (`AUTH_MODE=dev`, refusé si `NODE_ENV=production`).

## Table des endpoints

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| GET | `/api/v1/health` | public (pas d'auth) | — | `HealthSchema` |
| GET | `/api/v1/config/features` | public | — | `FeatureFlagsSchema` |
| GET | `/api/v1/me` | `user` | — | `UserIdentitySchema` |
| POST | `/api/v1/analyze/email` | `user` | `AnalyzeEmailRequestSchema` | `EmailAnalysisSchema` |
| POST | `/api/v1/analyze/thread` | `user` | `AnalyzeThreadRequestSchema` | `ThreadSynthesisSchema` |
| POST | `/api/v1/draft/reply` | `user` | `DraftReplyRequestSchema` | `DraftReplySchema` |
| POST | `/api/v1/search` | `user` | `SearchRequestSchema` | `SearchResponseSchema` |
| POST | `/api/v1/chat` | `user` | `ChatRequestSchema` | `ChatResponseSchema` |
| GET | `/api/v1/chat/:id` | `user` (propriétaire de la session) | — | `z.array(ChatMessageSchema)` |
| POST | `/api/v1/index/emails` | `user` | `IndexEmailsRequestSchema` | `IndexEmailsResponseSchema` |
| POST | `/api/v1/actions/propose` | `user` | `ProposeActionsRequestSchema` | `ActionProposalSchema` |
| POST | `/api/v1/actions/approve` | `user` (sur ses propres propositions) | `ApproveActionsRequestSchema` | `ApproveActionsResponseSchema` |
| POST | `/api/v1/actions/:id/result` | `user` | `ReportActionResultRequestSchema` | `ActionResultSchema` |
| POST | `/api/v1/compliance/check` | `user` | `ComplianceCheckRequestSchema` | `ComplianceCheckResponseSchema` |
| POST | `/api/v1/compliance/phishing` | `user` | `PhishingCheckRequestSchema` | `PhishingCheckResponseSchema` |
| GET | `/api/v1/compliance/escalations` | `compliance` | query: `{ status? }` | `z.array(EscalationSchema)` |
| POST | `/api/v1/compliance/escalations` | `user` | `EscalationRequestSchema` | `EscalationSchema` |
| GET | `/api/v1/compliance/escalations/:id` | `compliance` | — | `EscalationSchema` |
| POST | `/api/v1/compliance/escalations/:id/decision` | `compliance`/`admin` | `EscalationDecisionRequestSchema` (`{ decision: "approved"\|"rejected", comment? }`) | `EscalationSchema` |
| POST | `/api/v1/automations/observe` | `user` | `{ events: UserActionEvent[] }` (un tableau nu ou un événement seul sont aussi acceptés) | `202 { stored: number }` |
| POST | `/api/v1/automations/detect` | `user` | — | `z.array(AutomationSchema)` (nouvellement détectées) |
| GET | `/api/v1/automations` | `user` | query: `{ status? }` | `z.array(AutomationSchema)` |
| GET | `/api/v1/automations/:id` | `user` | — | `AutomationSchema` |
| PATCH | `/api/v1/automations/:id` | `user` | `AutomationPatchSchema` (« Edit rule », `status: "paused"\|"active"`) | `AutomationSchema` (une règle modifiée repasse en `proposed` et doit être re-simulée) |
| POST | `/api/v1/automations/:id/simulate` | `user` | `SimulateAutomationRequestSchema` | `AutomationSchema` (avec `lastSimulation`) |
| POST | `/api/v1/automations/:id/approve` | `user` | `AutomationDecisionRequestSchema` | `AutomationSchema` |
| POST | `/api/v1/automations/:id/reject` | `user` | `AutomationDecisionRequestSchema` | `AutomationSchema` |
| GET | `/api/v1/audit` | `admin`/`compliance` | query: `AuditQuerySchema` | `AuditPageSchema` |
| GET | `/api/v1/audit/stats` | `admin`/`compliance` | query: `{ from?, to? }` | `AuditStatsSchema` |
| GET | `/api/v1/audit/:id` | `admin`/`compliance` | — | `AuditEventSchema` |
| GET | `/api/v1/audit/export` | `admin`/`compliance` | query: `AuditQuerySchema` | `text/csv` |
| POST | `/api/v1/feedback` | `user` | `FeedbackRequestSchema` | `{ ok: true }` |
| GET | `/api/v1/admin/policy` | `admin` | — | `PolicySchema` |
| PUT | `/api/v1/admin/policy` | `admin` | `PolicySchema` (partiel accepté) | `PolicySchema` |
| GET | `/api/v1/admin/users` | `admin` | — | `z.array(AdminUserSchema)` |

Toute erreur suit `ApiErrorSchema` avec un code parmi : `validation_error`
(400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict`
(409), `llm_unavailable` (502), `graph_unavailable` (503).

## Exemples curl (endpoints principaux)

Variables utilisées ci-dessous :

```bash
export API=http://localhost:8080/api/v1
export AUTH='-H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User"'  # AUTH_MODE=dev
```

### Health

```bash
curl -s "$API/health" | jq
```

### Analyser un email

```bash
curl -s -X POST "$API/analyze/email" \
  -H "Content-Type: application/json" \
  -H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User" \
  -d '{
    "email": {
      "id": "msg-1",
      "subject": "Q2 vendor risk assessment",
      "from": { "name": "Sarah Johnson", "address": "sarah.johnson@vendorco.com" },
      "to": [{ "address": "demo@northbridge.example" }],
      "body": "Please review the attached Q2 vendor risk assessment, high-risk findings need approval."
    },
    "language": "en"
  }' | jq
```

### Chat conversationnel

```bash
curl -s -X POST "$API/chat" \
  -H "Content-Type: application/json" \
  -H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User" \
  -d '{ "message": "Find the email where the client approved the mandate.", "language": "en" }' | jq
```

### Vérification de conformité avant envoi

```bash
curl -s -X POST "$API/compliance/check" \
  -H "Content-Type: application/json" \
  -H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User" \
  -d '{
    "draft": {
      "to": [{ "address": "michael.brown@clientco.com" }],
      "subject": "Q2 Performance Report",
      "body": "Attached is the confidential Q2 performance report.",
      "attachments": [{ "name": "Client A - Q2 Performance Report.pdf" }]
    },
    "language": "en"
  }' | jq
```

### Proposer puis approuver des actions (human-in-the-loop)

```bash
PROPOSAL=$(curl -s -X POST "$API/actions/propose" \
  -H "Content-Type: application/json" \
  -H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User" \
  -d '{ "email": { "id": "msg-1", "subject": "Q2 vendor risk assessment", "body": "..." } }')

echo "$PROPOSAL" | jq

PROPOSAL_ID=$(echo "$PROPOSAL" | jq -r .proposalId)
ACTION_ID=$(echo "$PROPOSAL" | jq -r .actions[0].id)

curl -s -X POST "$API/actions/approve" \
  -H "Content-Type: application/json" \
  -H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User" \
  -d "{ \"proposalId\": \"$PROPOSAL_ID\", \"actionIds\": [\"$ACTION_ID\"] }" | jq
```

### Journal d'audit (rôle admin/compliance)

```bash
curl -s "$API/audit?page=1&pageSize=25" \
  -H "x-user-email: admin@northbridge.example" -H "x-user-name: Admin" | jq
```

Voir `scripts/smoke-test.sh` pour un script prêt à l'emploi couvrant health +
analyze/email + compliance/check + chat.

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

### Système et probes

| Méthode | Route | Rôle requis | Requête | Réponse |
|---|---|---|---|---|
| GET | `/api/v1/live` | public (pas d'auth) | — | `200 { status, version, role, uptimeSeconds }` — liveness : ne touche **aucune** dépendance |
| GET | `/api/v1/ready` | public | — | `200 { status: "ok", version }` / `503 { status: "unready", detail }` — readiness : base joignable **et** migrations appliquées |
| GET | `/api/v1/health` | public | — | `HealthSchema` (`ok`/`degraded`/`down` + détail par dépendance ; check `laya` présent seulement si `DECISION_PROVIDER≠disabled`, sans URL ni clé) |
| GET | `/metrics` | public si `METRICS_TOKEN` vide, sinon `Authorization: Bearer <METRICS_TOKEN>` (ou `x-metrics-token`) | — | exposition Prometheus (`text/plain`). `404` si `METRICS_ENABLED=false`. **Hors** préfixe `/api/v1` pour être ciblable séparément par NetworkPolicy / ServiceMonitor |
| GET | `/api/v1/config/features` | public | — | `FeatureFlagsSchema` |
| GET | `/api/v1/me` | `user` | — | `UserIdentitySchema` |

### Analyse, brief, synchronisation

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| POST | `/api/v1/analyze/email` | `user` | `AnalyzeEmailRequestSchema` | `EmailAnalysisSchema` — **seul** appel qui peut atteindre le GPU. Champ **optionnel** `decisioning` (décisions structurées Laya, mode `active` uniquement ; absent sinon — les clients doivent fonctionner sans, cf. ci-dessous) |
| GET | `/api/v1/analyze/email/:emailId` | `user` | — | `EmailAnalysisSchema` — analyse **précalculée ou en cache**, jamais d'appel modèle. `404` = rien de calculé pour cet email (comportement normal sur un email neuf ou si `PRECOMPUTE_ENABLED=false`) : le client retombe sur le POST |
| POST | `/api/v1/analyze/thread` | `user` | `AnalyzeThreadRequestSchema` | `ThreadSynthesisSchema` |
| POST | `/api/v1/draft/reply` | `user` | `DraftReplyRequestSchema` | `DraftReplySchema` |
| GET | `/api/v1/brief/daily` | `user` | query : `{ date? }` (défaut : aujourd'hui dans `TZ`) | `DailyBriefSchema`. `404` si aucun brief n'a été généré pour cette date |
| POST | `/api/v1/brief/daily` | `user` | `DailyBriefRequestSchema` (`{ date?, refresh?, language? }`) | `DailyBriefSchema` — génération à la demande |
| GET | `/api/v1/mailbox/sync` | `user` (`admin` pour `?userId=`) | query : `{ userId? }` | `MailboxSyncStatusSchema` |
| POST | `/api/v1/mailbox/sync` | `user` (`admin` pour `?userId=`) | query : `{ userId? }` | `202 MailboxSyncStatusSchema & { result }` — déclenche un cycle immédiat, priorité `interactive` |

### Recherche et chat

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| POST | `/api/v1/search` | `user` | `SearchRequestSchema` | `SearchResponseSchema` |
| GET | `/api/v1/search` | `user` | query : `SearchRequestSchema` (`limit` coercé) | `SearchResponseSchema` |
| POST | `/api/v1/chat` | `user` | `ChatRequestSchema` | `ChatResponseSchema` |
| GET | `/api/v1/chat/:id` | `user` (propriétaire de la session) | — | `z.array(ChatMessageSchema)` |
| POST | `/api/v1/index/emails` | `user` | `IndexEmailsRequestSchema` | `IndexEmailsResponseSchema` |

### Actions (human-in-the-loop)

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| POST | `/api/v1/actions/propose` | `user` | `ProposeActionsRequestSchema` | `ActionProposalSchema` |
| POST | `/api/v1/actions/approve` | `user` (sur ses propres propositions) | `ApproveActionsRequestSchema` + en-tête **`Idempotency-Key`** (facultatif) | `ApproveActionsResponseSchema` |
| POST | `/api/v1/actions/:id/result` | `user` | `ReportActionResultRequestSchema` | `ActionResultSchema` |

### Conformité

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| POST | `/api/v1/compliance/check` | `user` | `ComplianceCheckRequestSchema` | `ComplianceCheckResponseSchema` |
| POST | `/api/v1/compliance/phishing` | `user` | `PhishingCheckRequestSchema` | `PhishingCheckResponseSchema` |
| GET | `/api/v1/compliance/escalations` | `compliance` | query : `{ status? }` | `z.array(EscalationSchema)` |
| POST | `/api/v1/compliance/escalations` | `user` | `EscalationRequestSchema` | `EscalationSchema` |
| GET | `/api/v1/compliance/escalations/:id` | `compliance` | — | `EscalationSchema` |
| POST | `/api/v1/compliance/escalations/:id/decision` | `compliance`/`admin` | `EscalationDecisionRequestSchema` (`{ decision: "approved"\|"rejected", comment? }`) | `EscalationSchema` |

### Automatisations

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| POST | `/api/v1/automations/observe` | `user` | `{ events: UserActionEvent[] }` (un tableau nu ou un événement seul sont aussi acceptés) | `202 { stored: number }` |
| POST | `/api/v1/automations/detect` | `user` | — | `z.array(AutomationSchema)` (nouvellement détectées) |
| GET | `/api/v1/automations` | `user` | query : `{ all? }` (`all=true` : toutes, pas seulement les actives) | `z.array(AutomationSchema)` |
| GET | `/api/v1/automations/:id` | `user` | — | `AutomationSchema` |
| PATCH | `/api/v1/automations/:id` | `user` | `AutomationPatchSchema` (« Edit rule » : `name`, `description`, `trigger`, `steps`, `status: "paused"\|"active"`, `comment`) | `AutomationSchema` — modifier `trigger`/`steps` remet le statut à `proposed` et efface `lastSimulation` : il faut re-simuler puis ré-approuver. `status: "paused"` n'est accepté que depuis `active`, `status: "active"` que depuis `paused` **et** avec une simulation (sinon `409`) |
| POST | `/api/v1/automations/:id/simulate` | `user` | `SimulateAutomationRequestSchema` (`{ sampleSize }`) | `AutomationSchema` (avec `lastSimulation`) |
| POST | `/api/v1/automations/:id/approve` | `user` | `AutomationDecisionRequestSchema` (`{ comment? }`) | `AutomationSchema` |
| POST | `/api/v1/automations/:id/reject` | `user` | `AutomationDecisionRequestSchema` | `AutomationSchema` |

### Audit et administration

| Méthode | Route | Rôle requis | Requête (schéma) | Réponse (schéma) |
|---|---|---|---|---|
| GET | `/api/v1/audit` | `user` (ses propres événements) · `admin`/`compliance` (tous) | query : `AuditQuerySchema` | `AuditPageSchema` |
| GET | `/api/v1/audit/stats` | `admin`/`compliance` | query : `{ from?, to? }` (défaut : 7 derniers jours) | `AuditStatsSchema` |
| GET | `/api/v1/audit/:id` | `user` (le sien) · `admin`/`compliance` | — | `AuditEventSchema` |
| GET | `/api/v1/audit/export` | `admin`/`compliance` | query : `AuditQuerySchema` moins `page`/`pageSize` | `text/csv` **en flux** |
| POST | `/api/v1/feedback` | `user` | `FeedbackRequestSchema` | `201 { ok: true }` |
| GET | `/api/v1/admin/policy` | `admin`/`compliance` | — | `PolicySchema` |
| PUT | `/api/v1/admin/policy` | `admin` | `PolicySchema` (partiel accepté) | `PolicySchema` |
| GET | `/api/v1/admin/users` | `admin` | — | `z.array(AdminUserSchema)` |
| GET | `/api/v1/admin/system` | `admin` | query : `{ userId? }` | `SystemStatusSchema` — file LLM (pending/running/concurrency/circuit), compteurs de cache analyse et embeddings, état de sync, uptime, feature flags ; champ optionnel `decisioning` (fournisseur, mode, état, circuit, stratégie de modèle, versions, seuils, compteurs — jamais l'URL ni la clé) |

Toute erreur suit `ApiErrorSchema` avec un code parmi : `validation_error`
(400), `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict`
(409), `llm_unavailable` (502), `graph_unavailable` (503), `database_error` (500).

## Cloisonnement par utilisateur

Chaque requête est filtrée sur `user.id` au niveau du dépôt : un `user` ne voit
que ses analyses, ses sessions de chat, ses automatisations, ses escalades et
ses événements d'audit. Seuls `admin` et `compliance` élargissent le périmètre —
et uniquement sur les routes qui le déclarent (`/audit*`,
`/compliance/escalations`, `/mailbox/sync?userId=`, `/admin/*`).

## `Idempotency-Key`

`POST /api/v1/actions/approve` accepte l'en-tête `Idempotency-Key` (alias
`x-idempotency-key`). Le couple `(utilisateur, clé)` est conservé pendant
`IDEMPOTENCY_TTL_HOURS` (24 h par défaut, purgé par le job de rétention) :

- **même clé, même corps** → la réponse stockée est rejouée telle quelle,
  aucune action n'est ré-exécutée ; un `AuditEvent` `action_approved` est écrit
  avec `details.idempotentReplay: true` ;
- **même clé, corps différent** → `409 conflict`.

C'est ce qui rend sûr le rejeu d'une approbation après un timeout réseau ou un
retry de l'add-in. Les autres endpoints ne sont pas idempotents : `propose`,
`detect` et `simulate` sont sans effet de bord durable, les décisions
d'escalade et d'automatisation sont des transitions d'état vérifiées.

## Filtres du journal d'audit

`AuditQuerySchema` (identique pour `/audit` et `/audit/export`) :

| Paramètre | Valeurs | Effet |
|---|---|---|
| `from` / `to` | ISO-8601 | fenêtre temporelle |
| `userId` | id | un utilisateur (ignoré — forcé sur soi — pour un `user`) |
| `type` | `AuditEventTypeSchema` | type d'événement |
| `riskLevel` | `low` \| `medium` \| `high` | niveau de risque |
| `approvalStatus` | `ApprovalStatusSchema` | état d'approbation |
| `search` | texte libre | recherche plein texte |
| **`source`** | `llm` \| `cache` \| `precomputed` \| `heuristic` | filtre sur `details.source` — *« montre-moi tout ce qui a réellement consommé du GPU »* |
| **`model`** | nom de modèle | filtre sur le modèle enregistré sur l'événement (utile après un changement de `LLM_MODEL` / `LLM_FAST_MODEL`) |
| `page` / `pageSize` | 1.. / 1–200 | pagination (`/audit` uniquement) |

## Export CSV (`GET /api/v1/audit/export`)

Réponse `text/csv; charset=utf-8`, `content-disposition: attachment;
filename="audit-<YYYY-MM-DD>.csv"`, `cache-control: no-store`. Le corps est
**streamé** avec une pagination *keyset* (`(timestamp, id) < curseur`, 500
lignes par page) : un export de deux ans ne charge jamais tout en mémoire et
reste correct pendant que de nouveaux événements s'ajoutent.

Colonnes, dans cet ordre :

```
id,timestamp,userId,userEmail,displayName,type,sourceLabel,sourceEmailId,
sourceCounterpart,riskLevel,approvalStatus,approvedBy,confidence,model,
latencyMs,correlationId,analysisSource,cached
```

`sourceLabel` / `sourceEmailId` / `sourceCounterpart` viennent de
`event.source` ; `analysisSource` (repli sur `details.source`) et `cached` de
`event.details`. Les champs contenant `"`, `,` ou un retour ligne sont échappés
selon RFC 4180. **Aucun contenu d'email n'y figure** : ni corps, ni prompt, ni
réponse — seulement des hashes côté `AuditEvent`, sauf si
`AUDIT_STORE_CONTENT=true` a été explicitement validé par la conformité.

## Exemples curl (endpoints principaux)

Variables utilisées ci-dessous :

```bash
export API=http://localhost:8080/api/v1
export AUTH='-H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User"'  # AUTH_MODE=dev
```

### Probes et métriques

```bash
curl -s "$API/live"  | jq     # liveness  : ne touche aucune dépendance
curl -s "$API/ready" | jq     # readiness : 503 si la base est injoignable
curl -s "$API/health" | jq    # vue détaillée par dépendance

# /metrics est hors du préfixe /api/v1
curl -s -H "Authorization: Bearer $METRICS_TOKEN" \
  http://localhost:8080/metrics | head
```

### Analyse précalculée, brief quotidien, synchronisation

```bash
# Tier 2 du volet : jamais d'appel modèle, 404 si rien n'est calculé
curl -s -o /dev/null -w '%{http_code}\n' \
  "$API/analyze/email/AAMkAGI2...%3D%3D" \
  -H "x-user-email: demo@northbridge.example"

curl -s "$API/brief/daily?date=2026-09-15" -H "x-user-email: demo@northbridge.example" | jq
curl -s -X POST "$API/brief/daily" -H "Content-Type: application/json" \
  -H "x-user-email: demo@northbridge.example" -d '{ "refresh": true }' | jq

curl -s "$API/mailbox/sync" -H "x-user-email: demo@northbridge.example" | jq
curl -s -X POST "$API/mailbox/sync" -H "x-user-email: demo@northbridge.example" | jq
```

### État runtime (rôle admin)

```bash
curl -s "$API/admin/system" -H "x-user-email: admin@northbridge.example" | jq \
  '{queue: .llmQueue, cache: .cache, sync: .sync, uptime: .uptimeSeconds}'
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

# Idempotency-Key : rejouer exactement la même commande renvoie la réponse
# stockée au lieu d'exécuter les actions une seconde fois.
curl -s -X POST "$API/actions/approve" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid-v4-unique-par-tentative>" \
  -H "x-user-email: demo@northbridge.example" -H "x-user-name: Demo User" \
  -d "{ \"proposalId\": \"$PROPOSAL_ID\", \"actionIds\": [\"$ACTION_ID\"] }" | jq
```

### Journal d'audit (rôle admin/compliance)

```bash
curl -s "$API/audit?page=1&pageSize=25" \
  -H "x-user-email: admin@northbridge.example" -H "x-user-name: Admin" | jq

# Tout ce qui a réellement consommé du GPU sur un modèle donné
curl -s "$API/audit?source=llm&model=qwen3-30b-a3b&from=2026-09-01T00:00:00Z" \
  -H "x-user-email: admin@northbridge.example" | jq '.total'

# Export CSV streamé (deux ans tiennent sans charger la mémoire du pod)
curl -sS "$API/audit/export?from=2024-01-01T00:00:00Z&source=llm" \
  -H "x-user-email: admin@northbridge.example" -o audit.csv
head -1 audit.csv
```

Voir `npm run smoke` (`scripts/smoke.mjs`) pour un script prêt à l'emploi,
multi-plateforme, couvrant les probes (`/live`, `/ready`), `/metrics`,
`/config/features`, analyze/email, compliance/check et chat :

```bash
npm run smoke                                              # instance locale
npm run smoke -- --url https://api.oao.northbridge.example \
           --token "$JWT" --metrics-token "$METRICS_TOKEN" --wait 60
```

## Champ optionnel `decisioning` (moteur de décision Laya)

Ajouté à `EmailAnalysisSchema` sans rien retirer : absent quand
`DECISION_PROVIDER=disabled` (défaut) ou en mode `shadow`. Présent en mode
`active`, avec uniquement les décisions qui ont passé le seuil de confiance
([`LAYA.md`](LAYA.md)) :

```jsonc
"decisioning": {
  "source": "laya",                    // laya | taxonomy | llm_fallback | heuristic | laya_shadow | disabled
  "mode": "active",
  "urgency": { "level": "high", "confidence": 0.91 },
  "businessArea": { "id": "operations", "label": "Opérations", "confidence": 0.88 },
  "suggestedFolder": { "id": "nav", "displayName": "Operations/NAV", "outlookFolder": "Operations/NAV", "confidence": 0.84, "source": "laya" },
  "replyExpected": { "value": true, "confidence": 0.8 },
  "actionRequired": { "value": true, "confidence": 0.77 },
  "lowConfidence": false,              // au moins une réponse écartée par le seuil
  "degraded": false,                   // le moteur a échoué pour cet email
  "fallbackReason": "low_confidence",  // facultatif, identifiant technique, jamais de contenu
  "model": "multilingual",
  "taxonomyVersion": "v1",
  "decisionVersion": "v1"
}
```

Un dossier suggéré n'est jamais exécuté : il peut donner lieu à une action
`move_to_folder` **proposée** (`requiresConfirmation: true`, non présélectionnée)
dans `suggestedActions`, qui suit le circuit habituel d'approbation.

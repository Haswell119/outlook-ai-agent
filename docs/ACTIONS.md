# Catalogue des actions — Outlook AI Orchestrator

> Référence de tous les `ActionType` du contrat (`packages/shared/src/index.ts`
> — `ActionTypeSchema`). Pour chaque type : cible d'exécution
> (`ExecutionTarget`), paramètres attendus (`SuggestedAction.parameters` /
> `ProposedAction.parameters`, libres côté zod — forme documentée ici),
> niveau de risque par défaut, et l'instruction client correspondante quand
> `executionTarget = "server"` et que Graph est indisponible (repli
> `ActionResultStatus = "pending_client"` avec `clientInstruction`).
>
> Le niveau de risque par défaut peut être relevé par la policy active
> (`Policy.approvalRequiredFrom`, `Policy.complianceApprovalFor`) — voir
> `docs/SECURITY.md` §7 pour la matrice de gouvernance complète.

| `ActionType` | Cible d'exécution | Paramètres attendus | Risque | Instruction client (repli / exécution) |
|---|---|---|---|---|
| `draft_reply` | `client` | `{ intent, tone, body, subject }` | low | `item.displayReplyForm({ htmlBody })` — ouvre un brouillon, **jamais envoyé** par l'IA |
| `create_reminder` | `server` (Graph calendar), repli `client` | `{ title, dueDate, notes? }` | medium | `displayNewAppointmentForm({ subject, body, start, end })` |
| `create_task` | `server` (Graph To Do), repli `client` | `{ title, dueDate?, owner? }` | medium | `displayNewAppointmentForm(...)` utilisé comme rappel équivalent (pas d'API To Do côté Office.js) |
| `categorize` | `client` | `{ category }` | low | `item.categories.addAsync([category])` |
| `classify_email` | `client` | `{ category, confidence }` | low | `item.categories.addAsync([category])` (variante de `categorize` issue de la classification automatique — `EmailAnalysis.classification`) |
| `archive` | `server` (Graph move → dossier Archive), repli `client` | `{ }` | low | Instruction d'ouvrir la boîte de dialogue "Déplacer" (`ui.displayDialogAsync` ou équivalent) — l'utilisateur confirme le déplacement |
| `move_to_folder` | `server` (Graph `move`), repli `client` | `{ folderName }` | low | Idem `archive`, dossier cible pré-rempli |
| `flag` | `client` | `{ flagStatus? }` | low | `item.flag.setAsync({ flagStatus })` |
| `apply_label` | `client` (si `item.sensitivityLabel` dispo), sinon instruction | `{ label }` | low | Instruction d'appliquer manuellement le label de sensibilité (l'API Office.js de labellisation n'est pas garantie sur tous les hosts) |
| `notify` | `server` (audit + webhook), sinon `none` | `{ recipient?, message }` | low | — (informationnel : `NOTIFY_WEBHOOK_URL`, pas d'action côté client) |
| `request_document` | `client` | `{ documentName, requestedFrom }` | low | Ouvre un brouillon de réponse pré-rempli demandant le document manquant |
| `escalate_compliance` | `server` (crée une `Escalation`) | `{ reason, issues }` | high | — (aucune exécution client ; l'escalade attend une `compliance_decision`, voir `docs/API.md` `escalationDecision`) |
| `remove_attachment` | `client` (compose uniquement) | `{ attachmentId }` | low | `item.removeAttachmentAsync(attachmentId)` |
| `request_approval` | `server` (crée une `Escalation` de type approbation manager/compliance) | `{ reason, approverRole }` | medium | — (aucune exécution client ; utilisé par le Compliance Guardian pour "Request approval from a manager or compliance officer") |

## Notes

- **`send` et `delete` n'existent pas** comme `ActionType` : ce sont des
  exclusions de périmètre volontaires (voir `docs/SECURITY.md` §4), pas des
  actions désactivées par configuration.
- Le niveau de risque du tableau est celui **par défaut** dans le moteur de
  risque (`domain/risk/`) ; la policy active peut le faire remonter (jamais
  descendre) via `Policy.approvalRequiredFrom` et
  `Policy.complianceApprovalFor`.
- `requiresApproval` est vrai dès `riskLevel ≥ Policy.approvalRequiredFrom`
  (par défaut `low`, donc **toutes** les actions proposées passent par
  l'écran d'approbation humaine — voir le mock-up "Action approval dialog",
  `docs/mockups.md` §F).
- `requiresComplianceApproval` est vrai uniquement pour les types listés dans
  `Policy.complianceApprovalFor` (par défaut : `escalate_compliance` seul —
  ajustable depuis le Policy Center de l'admin dashboard).

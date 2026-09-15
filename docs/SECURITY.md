# Sécurité — Outlook AI Orchestrator

> Modèle de menace, flux de données, minimisation, RBAC et gouvernance des
> actions IA. Termes techniques laissés en anglais.

## 1. Modèle de menace

Actifs à protéger :

- **Contenu des emails** (sujet, corps, pièces jointes) des utilisateurs
  Northbridge, potentiellement des données clients sensibles (KYC, mandats,
  informations de portefeuille).
- **Décisions/actions proposées par l'IA** et leur exécution (risque
  d'automatisation incorrecte ou non désirée).
- **Jetons d'authentification** (SSO Office/AAD, jeton Graph échangé en
  On-Behalf-Of).
- **Journal d'audit** (preuve de conformité — intégrité et disponibilité
  critiques).

Acteurs de menace considérés :

| Acteur | Vecteur | Mitigation |
|---|---|---|
| Attaquant externe (phishing entrant) | Email malveillant analysé par l'IA, tentative d'injection de prompt dans le corps du mail | Screening anti-phishing dédié (`phishing` dans `EmailAnalysis`, `PhishingCheckResponse`) ; le contenu email est traité comme **donnée**, jamais interprété comme instruction système dans le prompt builder (`domain/prompts/`) ; sortie LLM validée par zod, jamais exécutée directement |
| Attaquant externe (exfiltration via compose) | Envoi d'informations sensibles/confidentielles à un destinataire externe | Compliance Guardian bloque/alerte avant envoi (`compliance/check`, verdict `block`/`warn`), jamais l'IA n'envoie elle-même (`send` hors scope, voir §5) |
| Utilisateur interne malveillant ou négligent | Approbation d'actions à risque sans lecture, contournement du HITL | Toute action à risque `medium`/`high` reste **human-in-the-loop** (`humanValidationRequired: true`), chaque approbation est nominative et auditée (`approvedBy`) |
| Compromission de compte (jeton volé) | Rejeu d'un jeton SSO/Graph | Jetons courte durée (SSO Office), validation JWT stricte (issuer/audience/JWKS) en `AUTH_MODE=aad`, `TENANT_ID` épinglé, pas de session longue durée côté orchestrator |
| Fuite depuis les logs / la base d'audit | Corps d'email en clair dans les logs ou la DB | `AUDIT_STORE_CONTENT=false` par défaut (hashes SHA-256 uniquement), voir §3 |
| Modèle IA interne compromis / malveillant | Sortie IA manipulatrice (auto-approbation, fuite de contexte) | Sortie toujours validée par des schémas zod stricts, jamais de champ "exécuter directement" dans la sortie LLM — l'exécution passe uniquement par le pipeline `propose → approve (humain) → execute` |
| Déni de service sur le modèle interne | Le GPU/LLM interne devient indisponible | Repli heuristique dégradé documenté (`docs/OPERATIONS.md` §6), pas de blocage total du produit |

## 2. Flux de données

```
Outlook (add-in, Office.js)
   │  HTTPS + bearer (SSO Office / dev header)
   ▼
Orchestrator (Fastify)
   │  validation zod stricte de CHAQUE payload entrant
   │
   ├─► LLM interne (OpenAI-compatible, réseau interne Northbridge)
   │     - prompt = contenu minimisé de l'email + instructions système
   │     - AUCUNE donnée n'est envoyée à un service tiers/cloud public
   │
   ├─► PostgreSQL + pgvector (réseau interne)
   │     - audit_events (hashes, pas le corps par défaut)
   │     - email_index (pour la recherche sémantique, si activée)
   │
   └─► Microsoft Graph (optionnel, OBO) — uniquement si GRAPH_ENABLED=true
         - jeton échangé On-Behalf-Of (jamais stocké), scopes minimaux (§6)

Admin dashboard (Next.js) ──HTTPS + bearer──► Orchestrator (lecture seule sur
                                               l'audit, décisions compliance,
                                               policy)
```

Aucune donnée n'est envoyée à un fournisseur cloud IA public : le modèle est
hébergé en interne par Northbridge (GPU on-prem), donc l'ensemble du flux "contenu
d'email → prompt → réponse" reste sur le réseau interne.

## 3. Minimisation des données — ce qui est stocké

- **Seuls les champs de `EmailContext`** (contrat `@oao/shared`) sont envoyés
  par l'add-in à l'orchestrator : sujet, expéditeur/destinataires, corps texte
  (HTML déjà retiré côté client), métadonnées de pièces jointes (nom, taille,
  type — **pas** le contenu binaire, sauf texte extrait explicitement fourni).
- **Audit (`AuditEvent.details`)** : par défaut, uniquement des **hashes
  SHA-256** du prompt et de la réponse du modèle, plus des métadonnées
  structurées (type d'action, risque, confiance, modèle utilisé, latence).
  Le corps brut de l'email n'est **pas** stocké, sauf
  `AUDIT_STORE_CONTENT=true` — option explicite, désactivée par défaut, à
  n'activer qu'après validation compliance et dans un cadre légal défini
  (ex. obligation de conservation FINMA sur certains flux).
- **Index sémantique (`email_index`, pgvector)** : activé uniquement si
  `EMBEDDINGS_ENABLED=true` ; contient les vecteurs d'embedding + les
  métadonnées nécessaires à la citation de sources (sujet, expéditeur, date,
  extrait). Sa suppression/rotation suit la même politique de rétention que
  l'audit.
- **Aucun mot de passe / secret utilisateur** n'est jamais demandé ou stocké
  par l'add-in ou l'orchestrator (authentification déléguée à Azure AD / SSO
  Office).

## 4. Ce qui n'est jamais fait par l'IA

- **`send`** : envoi d'un email — **hors scope**, n'existe pas comme
  `ActionType`. L'IA ne prépare que des brouillons (`draft_reply`, jamais
  envoyés automatiquement — `item.displayReplyForm`).
- **`delete`** : suppression de message — **hors scope**, pas un `ActionType`.
- Toute action à risque `medium` ou `high` requiert une validation humaine
  explicite avant exécution (`ActionProposal.humanValidationRequired: true`).

## 5. RBAC

| Rôle | Périmètre |
|---|---|
| `user` | Utilise l'add-in : résumés, chat, brouillons, propose/approuve ses propres actions, déclenche les vérifications de conformité sur ses propres compositions. |
| `compliance` | Tout ce que `user` peut faire, + accès aux escalades (`/api/v1/compliance/escalations`), décision d'approbation/rejet des escalades compliance. |
| `admin` | Accès complet au dashboard admin : audit global, policy (`/api/v1/admin/policy`), gestion des utilisateurs (`/api/v1/admin/users`), toutes les analytics. |

- En `AUTH_MODE=aad` : rôles portés par les **app roles** / groupes Azure AD
  (assignés dans Enterprise Applications, voir `docs/SETUP.md` §6).
- En `AUTH_MODE=dev` (local uniquement, refusé si `NODE_ENV=production`) :
  rôles dérivés de `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` (listes d'emails dans
  `.env`), tout le reste est `user`.
- Chaque route contrôleur vérifie le rôle requis avant d'appeler le service
  (403 `forbidden` sinon) — voir `docs/API.md` pour le rôle requis par
  endpoint.

## 6. Conformité "FINMA-friendly"

Principes retenus pour rester compatible avec les attentes typiques d'un
régulateur financier suisse (traçabilité, contrôle humain, minimisation,
hébergement interne) :

- **Traçabilité intégrale** : chaque suggestion/action IA génère un
  `AuditEvent` non-négociable (aucun chemin de code ne peut produire une
  action sans entrée d'audit correspondante).
- **Contrôle humain systématique** sur toute action à impact (au minimum
  `medium`), jamais d'exécution autonome d'actions à risque.
- **Hébergement interne du modèle IA** (Northbridge GPU) — aucune donnée client
  envoyée à un tiers cloud public par défaut.
- **Minimisation des données** stockées (hashes plutôt que contenu, §3).
- **Séparation des rôles** (RBAC §5), en particulier l'équipe compliance a un
  chemin de décision dédié et auditable (`compliance_escalated` →
  `compliance_decision`).
- **Réversibilité / auditabilité des automatisations** : toute automatisation
  passe par `proposed → simulated → approved/active`, avec un historique
  d'activité consultable (`lastSimulation`, `View activity history`).
- **Conservation et purge contrôlées** de l'audit (`docs/OPERATIONS.md` §8),
  alignées sur les durées légales applicables (à valider avec l'équipe
  compliance/juridique de Northbridge selon le flux concerné — ce document ne
  fixe pas de durée réglementaire précise, il documente le mécanisme).

> Ce document décrit l'architecture technique de conformité ; il ne remplace
> pas une revue juridique/réglementaire formelle par l'équipe compliance de
> Northbridge Capital avant mise en production.

## 7. Matrice de gouvernance (action / risque / validation)

Reprise du dossier projet (voir aussi `docs/ACTIONS.md` pour le catalogue
complet des `ActionType`) :

| Action | Risque | Validation requise |
|---|---|---|
| Résumer (summarize) | — | Automatique (aucune validation nécessaire) |
| Brouillon de réponse (draft) | Faible | Jamais envoyé automatiquement — l'utilisateur relit et envoie lui-même |
| Catégoriser / étiqueter (categorize/tag) | Faible | Validation simple (un clic) |
| Créer un rappel / une tâche (reminder) | Moyen | Validation simple, action loggée |
| Automatisation (Automation Coach) | Variable | Simulation obligatoire avant toute activation (`Run simulation` avant `Approve automation`) |
| Envoyer (send) | — | **Jamais par l'IA** — hors scope produit |
| Pièce jointe sensible vers externe | Élevé | Alerte / blocage / validation compliance obligatoire (`escalate_compliance`, verdict `block`) |
| Supprimer (delete) | — | **Hors scope** — n'existe pas comme action IA |

Traduction dans le contrat (`ProposedAction`) : `riskLevel` (`low` / `medium`
/ `high`), `requiresApproval` (toujours vrai dès `low` par défaut —
`Policy.approvalRequiredFrom`), `requiresComplianceApproval` (vrai pour les
actions dans `Policy.complianceApprovalFor`, ex. `escalate_compliance`), et
`Policy.blockOnHighRisk` pour bloquer l'envoi tant qu'une issue de conformité
`high` n'est pas résolue.

## 8. Permissions Microsoft Graph — justification de chaque scope

| Scope | Phase | Justification | Utilisé par |
|---|---|---|---|
| `Mail.Read` | 1 | Lecture de la boîte pour l'indexation/recherche conversationnelle et la synthèse de thread au-delà du seul item ouvert dans Office.js. Lecture seule — pas de modification possible. | `search`, `chat`, `analyze/thread` (mode Graph) |
| `Mail.ReadWrite` | 2+ | Nécessaire pour les actions serveur `archive` / `move_to_folder` (déplacement de message) proposées puis approuvées par l'utilisateur. Jamais utilisé pour envoyer un message (aucun scope `Mail.Send` demandé — cohérent avec §4). | `ProposeActions` → `ApproveActions` (actions `archive`, `move_to_folder`) |
| `Tasks.ReadWrite` | 2+ | Création de tâches Microsoft To Do pour l'action `create_task`, avec repli client (Office.js) si Graph est indisponible ou le scope non consenti. | action `create_task` |
| `Calendars.ReadWrite` | 2+ | Création de rappels/événements calendrier pour l'action `create_reminder`. | action `create_reminder` |
| `offline_access` | 1 | Rafraîchissement du jeton nécessaire à l'échange On-Behalf-Of côté orchestrator (le jeton Office SSO initial a une durée de vie courte) — sans ce scope, l'OBO échoue dès l'expiration du jeton initial. | échange OBO (`adapters/graph/`) |

Principe appliqué : **aucun scope non utilisé n'est demandé** (pas de
`Mail.Send`, pas de `User.ReadWrite.All`, pas de scope applicatif large type
`Mail.ReadWrite.All`) ; chaque scope est déclenché uniquement quand la phase
correspondante (`docs/ARCHITECTURE.md` §9) est activée en production, et le
consentement admin (§6 de `docs/SETUP.md`) est donné scope par scope au fur et
à mesure du déploiement des phases, pas en une seule fois pour toutes les
phases futures.

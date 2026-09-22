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
| Attaquant externe (exfiltration via compose) | Envoi d'informations sensibles/confidentielles à un destinataire externe | Compliance Guardian bloque/alerte avant envoi (`compliance/check`, verdict `block`/`warn`), jamais l'IA n'envoie elle-même (`send` hors scope, voir §4) |
| Utilisateur interne malveillant ou négligent | Approbation d'actions à risque sans lecture, contournement du HITL | Toute action à risque `medium`/`high` reste **human-in-the-loop** (`humanValidationRequired: true`), chaque approbation est nominative et auditée (`approvedBy`) |
| Compromission de compte (jeton volé) | Rejeu d'un jeton SSO/Graph | Jetons courte durée (SSO Office), validation JWT stricte (issuer/audience/JWKS) en `AUTH_MODE=aad`, `AAD_TENANT_ID` épinglé (plus `AAD_ALLOWED_TENANTS` si des tenants invités sont explicitement acceptés), tolérance d'horloge bornée par `AAD_CLOCK_SKEW_SECONDS`, pas de session longue durée côté orchestrator |
| Fuite depuis les logs / la base d'audit | Corps d'email en clair dans les logs ou la DB | `AUDIT_STORE_CONTENT=false` par défaut (hashes SHA-256 uniquement), voir §3 |
| Modèle IA interne compromis / malveillant | Sortie IA manipulatrice (auto-approbation, fuite de contexte) | Sortie toujours validée par des schémas zod stricts, jamais de champ "exécuter directement" dans la sortie LLM — l'exécution passe uniquement par le pipeline `propose → approve (humain) → execute` |
| Déni de service sur le modèle interne | Le GPU/LLM interne devient indisponible | Repli heuristique dégradé documenté (`docs/OPERATIONS.md` §11), pas de blocage total du produit |

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

### 3.1 Cloisonnement par utilisateur

Le cloisonnement n'est pas une affaire de rôle mais de **requête** : chaque
lecture de dépôt est filtrée sur `user.id` avant d'atteindre la base. Un `user`
ne peut pas lire l'analyse, la session de chat, l'automatisation, l'escalade ou
l'événement d'audit d'un collègue, même en connaissant l'identifiant.

L'élargissement du périmètre est explicite, route par route, et réservé à
`admin`/`compliance` : `/audit*`, `/compliance/escalations`,
`/mailbox/sync?userId=`, `/admin/*`. `AuditService.streamCsv()` réapplique la
contrainte côté serveur (`scoped = hasRole(admin|compliance) ? q : {…q, userId:
user.id}`) : un `user` qui appellerait l'export n'obtiendrait que ses propres
lignes. Le cache d'analyses et le cache d'embeddings sont indexés par hash de
contenu **et** par propriétaire, de sorte qu'un hit ne peut pas traverser une
frontière de boîte.

### 3.2 Idempotence des approbations

`POST /api/v1/actions/approve` accepte un en-tête `Idempotency-Key`. Le couple
`(utilisateur, clé)` est conservé pendant `IDEMPOTENCY_TTL_HOURS` (24 h par
défaut) avec le **hash de la requête** et la réponse produite :

- même clé + même corps → la réponse stockée est rejouée, **aucune action n'est
  ré-exécutée**, et un `AuditEvent` `action_approved` est écrit avec
  `details.idempotentReplay: true` (le rejeu reste tracé) ;
- même clé + corps différent → `409 conflict`.

C'est la garantie qu'un retry réseau de l'add-in, ou un double clic, ne crée pas
deux rappels ni deux tâches. Les enregistrements sont purgés par le job de
rétention. L'en-tête est **rédigé** dans les logs (`req.headers['idempotency-key']`
fait partie de la liste `redact` de pino).

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
  (assignés dans Enterprise Applications, voir `docs/SETUP.md` §3).
- En `AUTH_MODE=dev` (local uniquement, refusé si `NODE_ENV=production`) :
  rôles dérivés de `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` (listes d'emails dans
  `.env`), tout le reste est `user`.
- Chaque route contrôleur vérifie le rôle requis avant d'appeler le service
  (403 `forbidden` sinon) — voir `docs/API.md` pour le rôle requis par
  endpoint.
- **Dashboard admin** : en `ADMIN_AUTH_MODE=aad`, les rôles sont lus dans la
  claim `roles` de l'**access token** obtenu pour l'API (app roles `Admin` /
  `Compliance`), avec `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` en repli. Le
  middleware Next.js barre l'accès aux groupes de routes et redirige vers
  `/no-access` plutôt que de renvoyer une 404 (un utilisateur authentifié sans
  rôle doit comprendre pourquoi). `ADMIN_AUTH_MODE=token` distribue
  `ADMIN_DEV_ROLES` à quiconque ouvre la page : le dashboard **refuse de servir
  des données réelles** dans cette configuration quand `NODE_ENV=production`
  et que `ADMIN_MOCK` n'est pas activé — même règle que le refus
  d'`AUTH_MODE=dev` côté orchestrator.

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
- **Conservation et purge contrôlées** de l'audit (`docs/OPERATIONS.md` §13),
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

## 9. Modèle réseau — NetworkPolicies

Le chart Helm applique un **default-deny** sur le namespace (ingress *et*
egress), puis ouvre uniquement les flux nécessaires. Conséquence
opérationnelle à connaître : tout endpoint non déclaré est silencieusement
injoignable (voir `docs/OPERATIONS.md` §11).

```
                    ┌──────────────── namespace oao (default-deny) ────────────────┐
  Traefik           │                                                              │
 (ns kommander) ────┼──► oao-api:8080 ──┬──► oao-postgres:5432                     │
                    │                   ├──► LLM interne (llm.egress.cidrs:8000)   │
                    │                   └──► 443/tcp hors RFC1918                  │
                    │                        (login.microsoftonline.com,           │
                    │                         graph.microsoft.com)                 │
  Traefik ──────────┼──► oao-admin:3001 ─┬─► oao-api:8080                          │
                    │                    └─► 443/tcp (Entra ID, si authMode=aad)   │
  Traefik ──────────┼──► oao-addin:3000  ──► (DNS uniquement)                      │
                    │                                                              │
  Prometheus        │                                                              │
 (ns kommander) ────┼──► oao-api / oao-worker :8080/metrics                         │
                    │      oao-worker ──► postgres, LLM, Microsoft                 │
                    │      oao-migrate / oao-backup ──► postgres                   │
                    └──────────────────────────────────────────────────────────────┘
        Tout le reste (est-ouest, sortie Internet, accès direct à Postgres) : refusé.
```

| Politique | podSelector | Ingress autorisé | Egress autorisé |
|---|---|---|---|
| `oao-default-deny` | tous | — | — |
| `oao-api` | `component=orchestrator-api` | ns ingress (`kommander`), pods `admin`, ns monitoring | DNS, postgres, CIDR LLM, 443 Microsoft |
| `oao-worker` | `component=orchestrator-worker` | ns monitoring | idem API |
| `oao-admin` | `component=admin` | ns ingress | DNS, `oao-api:8080`, 443 Entra ID |
| `oao-addin` | `component=addin` | ns ingress | DNS uniquement (fichiers statiques) |
| `oao-postgres` | `component=postgres` | api, worker, migrate, backup | DNS |
| `oao-migrate` / `oao-backup` | jobs | — | DNS, postgres (+443 si backup S3) |

Limite assumée : `NetworkPolicy` ne sait pas filtrer par nom de domaine. Les
flux vers Entra ID et Graph sont donc exprimés comme « 443/tcp vers
l'Internet public, toutes les plages RFC1918 exclues ». Deux façons de
resserrer :

- renseigner `networkPolicy.microsoft.cidrs` avec les plages publiées par
  Microsoft (à maintenir), ou
- sur un NKP à CNI Cilium, doubler la politique d'une `CiliumNetworkPolicy`
  avec `toFQDNs` :

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: oao-api-microsoft-fqdn
  namespace: oao
spec:
  endpointSelector:
    matchLabels:
      app.kubernetes.io/component: orchestrator-api
  egress:
    - toFQDNs:
        - matchName: login.microsoftonline.com
        - matchPattern: "*.graph.microsoft.com"
        - matchName: graph.microsoft.com
      toPorts:
        - ports: [{ port: "443", protocol: TCP }]
```

Durcissement complémentaire appliqué par le chart : namespace en
`pod-security.kubernetes.io/enforce=restricted`, `runAsNonRoot`,
`readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`,
`automountServiceAccountToken: false` (aucun composant n'appelle l'API
Kubernetes).

## 10. En-têtes HTTP et Content-Security-Policy

Trois surfaces web, trois politiques, chacune produite par du code testé plutôt
qu'écrite à la main dans un HTML.

### Dashboard admin — CSP à nonce

`src/lib/security.ts` construit la politique, `src/middleware.ts` génère un
**nonce cryptographique par requête**, le pose sur les en-têtes de la *requête*
(pour que l'App Router estampille ses scripts de bootstrap inline) puis sur la
réponse :

```
default-src 'self'; base-uri 'self';
script-src 'self' 'nonce-<aléatoire>' 'strict-dynamic';
style-src 'self' 'unsafe-inline';        # Tailwind / Recharts — jamais de script inline
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self';                      # l'orchestrator n'est appelé QUE côté serveur
form-action 'self'; frame-ancestors 'none'; frame-src 'none';
object-src 'none'; worker-src 'self' blob:; manifest-src 'self';
upgrade-insecure-requests
```

`'nonce-…' 'strict-dynamic'` autorise exactement les scripts que Next.js
injecte, et rien d'autre : ni CDN, ni `eval` (sauf en développement). La CSP est
émise **uniquement** par le middleware ; `next.config.mjs` porte le reste des
en-têtes statiques (HSTS 2 ans preload, `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy`, `Permissions-Policy` fermée, COOP/CORP `same-origin`,
`Cache-Control: no-store` — le dashboard affiche de l'audit, aucun
intermédiaire ne doit le mettre en cache). Déclarer la CSP aux deux endroits
enverrait deux politiques contradictoires.

### Add-in — CSP gravée au build + en-tête du host statique

`apps/addin/src/security/csp.ts` construit la politique au build et l'injecte
dans un `<meta>` de `taskpane.html` / `commands.html`. Point clé :
**`connect-src` est réduit à l'origine du backend configuré**
(`VITE_API_BASE_URL`) — un volet compromis par une dépendance ne peut pas
exfiltrer du contenu d'email ailleurs que vers son propre orchestrator.
`script-src` n'autorise que `'self'` et les origines Office
(`appsforoffice.microsoft.com`, `*.office.net`, `*.officeapps.live.com`) ;
`'unsafe-eval'` n'est jamais accordé ; `'unsafe-inline'` l'est uniquement sur
`style-src` (Griffel injecte le CSS atomique de Fluent UI à l'exécution).

Un navigateur **ignore** `frame-ancestors`, `report-to` et `sandbox` dans un
`<meta>` : ces directives sont exportées séparément
(`HEADER_ONLY_DIRECTIVES`) et c'est **le host statique** qui les envoie.
`infra/docker/nginx.conf` reprend mot pour mot la valeur de `frameAncestors()`,
et **rien d'autre** : ajouter un second `default-src` dans l'en-tête
intersecterait la politique du `<meta>` et bloquerait office.js. Aucun
`X-Frame-Options` n'est envoyé — Outlook doit pouvoir encadrer le volet ; le
cadrage est borné par `frame-ancestors` seul.

Exigences d'hébergement associées, vérifiables en une commande chacune :

| Chemin | En-tête / réponse attendue | Pourquoi |
|---|---|---|
| `taskpane.html`, `commands.html`, `commands.js`, `/manifest/*` | `Cache-Control: no-cache, must-revalidate` | ils référencent les assets hashés ; un cache long fige une version |
| `/assets/*` | `Cache-Control: public, max-age=31536000, immutable` | contenu hashé par Vite, immuable par construction |
| `*.map` | **404** | source maps « hidden » (aucun `sourceMappingURL`) : elles vont à l'outil de suivi d'erreurs, pas sur le web |
| toute réponse | `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` | durcissement de base |

### Add-in — comportement à l'envoi (Smart Alerts)

La vérification de conformité à l'envoi (`ItemSend`) peut elle-même échouer :
orchestrator injoignable, circuit LLM ouvert, timeout. `VITE_ONSEND_FAIL_MODE`
(build-time, défaut `open`) décide de la réaction :

| Valeur | Comportement quand la vérification échoue | Quand la choisir |
|---|---|---|
| `open` (défaut) | l'envoi est **autorisé**, l'utilisateur est averti que le contrôle n'a pas pu s'exécuter | disponibilité prioritaire : une panne de l'orchestrator ne doit pas empêcher un gérant de répondre à un client |
| `closed` | l'envoi est **refusé** tant que la vérification ne fonctionne pas | conformité prioritaire : aucun mail sortant ne part sans contrôle |

Ce n'est pas un détail d'implémentation mais une **décision de conformité** :
`closed` transforme toute indisponibilité de l'orchestrator en blocage total de
la messagerie sortante des utilisateurs équipés. La valeur est figée au build de
l'image add-in (`--build-arg VITE_ONSEND_FAIL_MODE`) : la changer impose une
nouvelle image et un nouveau déploiement du manifest. À arbitrer et consigner
avant le go-live ([`PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md) §10).

Dans les deux modes, un verdict `block` **rendu** par la vérification bloque
toujours l'envoi : `open` ne concerne que l'échec du contrôle, jamais son
résultat.

### Orchestrator

Helmet + CORS restreint à `CORS_ORIGINS` (l'origine du volet), limite de corps
(`BODY_LIMIT_BYTES`), rate limit par utilisateur/IP (`RATE_LIMIT_PER_MINUTE`)
avec l'IP cliente réelle déterminée par `TRUST_PROXY`. `CORS_ORIGINS=*` est **refusé au démarrage** quand
`NODE_ENV=production` : le CORS est crédentié, un joker y annulerait la
protection d'origine. L'API ne sert aucune page : elle n'a donc pas besoin de
CSP à nonce, mais `API_DOCS_ENABLED` doit rester `false` en production
(Swagger UI charge des assets et décrit la surface d'attaque).

## 11. Revue de sécurité — correctifs appliqués

Constats de la revue de sécurité du code, et le contrôle qui les ferme. Chacun
est vérifiable dans le code cité.

| Constat | Correctif | Où |
|---|---|---|
| Le dashboard en `ADMIN_AUTH_MODE=token` distribue `ADMIN_DEV_ROLES` (défaut `admin`) à **quiconque ouvre la page**, sans aucune authentification | refusé quand `NODE_ENV=production` et que `ADMIN_MOCK` n'est pas activé (`insecureAuthMode`) — contrôle **au moment de la requête**, pour ne pas casser `next build` qui tourne en `NODE_ENV=production`. Même règle que le refus d'`AUTH_MODE=dev` côté orchestrator | `apps/admin/src/env.ts`, `src/middleware.ts`, `src/lib/session.ts` |
| Rate limit par IP seulement : derrière un ingress, tous les utilisateurs partagent une adresse et se bloquent mutuellement (ou personne n'est limité) | limite **par utilisateur authentifié**, avec repli sur l'IP cliente réelle déterminée par `TRUST_PROXY`. Le hook d'authentification passe avant, sinon `request.user` n'existerait pas encore | `apps/orchestrator/src/app.ts` |
| Les requêtes rejetées à l'authentification n'atteignent jamais le rate limit : le bruteforce de jeton était gratuit | `AuthFailureThrottle` — fenêtre fixe sur les **échecs** d'authentification, indexée par adresse source | `apps/orchestrator/src/auth/plugin.ts` |
| `Policy.sensitiveDataPatterns` est éditable depuis le Policy Center et exécuté sur chaque corps sortant. Le moteur RegExp de Node backtracke et **n'a pas de timeout** : un `(a+)+$` saisi dans un champ texte fige l'event loop de toutes les répliques (ReDoS → panne totale) | `checkPattern()` refuse à l'écriture les motifs trop longs (> 512 caractères), syntaxiquement invalides, ou de forme exponentielle connue (groupe quantifié dont le corps est lui-même quantifié, ou alternance répétée type `(a\|aa)+`). `PUT /api/v1/admin/policy` renvoie **400** avec le motif fautif nommé, au lieu de laisser passer un contrôle qui ne détecte rien ou qui tue le processus | `apps/orchestrator/src/util/text.ts`, `src/services/PolicyService.ts` |
| Injection de prompt depuis un email entrant : le contenu pouvait forger les délimiteurs de bloc et se faire passer pour une instruction système | le prompt système déclare explicitement que tout ce qui est dans `### EMAIL` / `### MESSAGE` / `### THREAD` est de la **donnée** non fiable, et `neutralizeDelimiters()` empêche le contenu de reproduire ces marqueurs. La sortie reste validée par schéma et aucune action ne s'exécute sans la boucle propose → approbation humaine → exécution | `apps/orchestrator/src/domain/prompts/format.ts` |
| Liens externes ouverts en `target="_blank"` sans `rel` : le document ouvert garde une référence `window.opener` sur le volet | tous les liens sortants portent `rel="noopener"` | `apps/addin/src/**`, `apps/admin/src/**` |
| `CORS_ORIGINS=*` avec CORS crédentié annule la protection d'origine | refusé au démarrage quand `NODE_ENV=production` (§10) | `apps/orchestrator/src/config.ts` |

## 12. Gestion des secrets

Aucun secret — même chiffré — n'est nécessaire au fonctionnement du dépôt
public. Trois stratégies, dans l'ordre de préférence :

| Stratégie | Où vit le secret | Quand l'utiliser |
|---|---|---|
| **External Secrets Operator** | coffre (Vault, Key Vault, Nutanix) ; rien en git | Northbridge dispose déjà d'un coffre |
| **SOPS + age** | git, chiffré ; clé age dans le coffre / `Secret sops-age` de Flux | GitOps pur, pas de coffre |
| `secrets.existingSecret` | Secret créé hors flux (kubectl, Sealed Secrets) | bootstrap, cluster de test |

Règles communes :

- Les secrets sont **montés en fichiers** (`secrets.mountAsFiles=true`,
  `/run/secrets/oao/<NOM>`, mode `0400`) et lus via `<NOM>_FILE`. Ils
  n'apparaissent ni dans l'environnement du pod, ni dans `kubectl describe
  pod`, ni dans un `docker inspect`.
  Le mécanisme est générique (`apps/orchestrator/src/util/secrets.ts`) : pour
  **toute** variable `FOO`, `FOO_FILE=/chemin` est lu au démarrage et remplit
  `FOO`. En pratique : `LLM_API_KEY_FILE`, `AAD_CLIENT_SECRET_FILE`,
  `ADMIN_API_TOKEN_FILE`, `METRICS_TOKEN_FILE`, `DATABASE_URL_FILE`,
  `NOTIFY_WEBHOOK_URL_FILE`. Le chart ne génère un `<NOM>_FILE` que pour les
  clés **réellement présentes** dans le Secret : un `*_FILE` pointant sur un
  fichier absent ferait échouer le démarrage (fail closed, jamais silencieux).
  Contrôle rapide :

  ```bash
  kubectl -n oao exec deploy/oao-api -- env | grep -c '^AAD_CLIENT_SECRET='   # 0
  kubectl -n oao exec deploy/oao-api -- env | grep '^AAD_CLIENT_SECRET_FILE=' # présent
  ```

  Corollaire d'exploitation : un secret changé n'est pris en compte qu'au
  redémarrage du pod (`rollout restart`).
- Les clés propres au dashboard (`AUTH_SECRET`,
  `AUTH_MICROSOFT_ENTRA_ID_SECRET`) ne sont **jamais** injectées dans les pods
  orchestrator, et inversement : cloisonnement par composant.
- Le module `apps/orchestrator/src/util/secrets.ts` rédige (`***`) toute valeur
  sensible dans les logs et le banner de démarrage, et masque le mot de passe
  des URL de connexion.
- La CI exécute **gitleaks** sur l'historique complet à chaque PR, doublé d'un
  `grep` de motifs évidents (clés AWS, blocs PEM, `client_secret=`).
- `.gitignore` exclut `.env`, `*.pem`, `*.key`, `*.crt` ; `.dockerignore`
  exclut en plus `**/certs` afin qu'aucun certificat n'entre dans une couche
  d'image.

Chiffrement SOPS (voir `infra/gitops/.sops.yaml`) : `encrypted_regex:
^(data|stringData)$` — seules les valeurs sont chiffrées, les métadonnées
(`kind`, `name`, `namespace`) restent lisibles pour kustomize et pour la
revue de code.

Rotation : `docs/OPERATIONS.md` §8.

## 13. Chaîne d'approvisionnement (supply chain)

Ce que produit `.github/workflows/release.yml` pour chaque tag `vX.Y.Z` :

| Artefact | Protection |
|---|---|
| Images `ghcr.io/<owner>/oao-{orchestrator,admin,addin}` | tags semver + sha, **signature cosign keyless** (OIDC GitHub, pas de clé à garder), build provenance SLSA (`provenance: mode=max`) |
| SBOM SPDX (syft) | publiée en asset de release **et** attachée comme attestation signée (`cosign attest --type spdxjson`) |
| Scan `trivy` | la release **échoue** sur toute vulnérabilité `CRITICAL` corrigeable |
| Chart Helm OCI | `ghcr.io/<owner>/charts/outlook-ai-orchestrator`, signé cosign |
| Manifests Office | `manifest.xml` / `manifest.json` rendus pour l'environnement de production, joints à la release |

Dépendances : le `package.json` racine épingle deux `overrides` npm
(`postcss >= 8.5.23`, `@fastify/static >= 10.1.2`) pour forcer les versions
corrigées dans tout l'arbre transitif, et Dependabot surveille npm, GitHub
Actions et Docker. **Avis résiduel assumé** : `uuid`, tiré transitivement par
`@azure/msal-node`, reste sur une version signalée ; le chemin de code
concerné n'est pas atteignable depuis l'orchestrator (aucune génération d'UUID
par msal n'est exposée à une entrée utilisateur) et aucune version amont
corrigée n'est disponible. À revoir à chaque montée de `@azure/msal-node`.

Vérification côté opérateur, avant un déploiement :

```bash
cosign verify ghcr.io/northbridge-capital/oao-orchestrator:1.2.3 \
  --certificate-identity-regexp '^https://github.com/northbridge-capital/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify-attestation --type spdxjson \
  ghcr.io/northbridge-capital/oao-orchestrator:1.2.3 \
  --certificate-identity-regexp '^https://github.com/northbridge-capital/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Vérification **imposée par le cluster** (admission) — Kyverno, disponible dans
le catalogue Kommander :

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: oao-require-signed-images
spec:
  validationFailureAction: Enforce
  background: false
  rules:
    - name: verify-oao-images
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [oao, oao-dev]
      verifyImages:
        - imageReferences:
            - "ghcr.io/northbridge-capital/oao-*"
          mutateDigest: true   # épingle le digest : plus de tag mutable en vol
          verifyDigest: true
          required: true
          attestors:
            - count: 1
              entries:
                - keyless:
                    subject: "https://github.com/northbridge-capital/outlook-ai-agent/.github/workflows/release.yml@refs/tags/*"
                    issuer: "https://token.actions.githubusercontent.com"
                    rekor:
                      url: https://rekor.sigstore.dev
```

Une politique complémentaire interdit les images non signées venant d'ailleurs :

```yaml
    - name: disallow-unsigned-third-party
      match:
        any: [{ resources: { kinds: [Pod], namespaces: [oao] } }]
      validate:
        message: "Seules les images GHCR Northbridge signées et les bases validées sont autorisées."
        pattern:
          spec:
            containers:
              - image: "ghcr.io/northbridge-capital/* | pgvector/pgvector:* | nginxinc/nginx-unprivileged:*"
```

Sur un cluster air-gapped, l'étape de vérification Rekor doit pointer vers une
instance interne, ou la politique passer en mode clé publique (`keys:` plutôt
que `keyless:`).

Autres contrôles de la chaîne :

- `npm ci` partout (CI et images) : il installe strictement ce que décrit
  `package-lock.json`, et un lockfile désynchronisé fait échouer le build
  plutôt que de résoudre une version imprévue.
- Dependabot sur npm, GitHub Actions et images de base, groupé par famille.
- CodeQL (`javascript-typescript` + `actions`, requêtes `security-extended`)
  sur chaque PR et chaque semaine.
- Images sans `curl` ni shell superflu, healthcheck en Node/busybox, rootfs en
  lecture seule (surface d'exploitation réduite).

## 14. Ajouts au modèle de menace (déploiement)

Compléments à §1, propres à l'exécution en cluster :

| Acteur / scénario | Vecteur | Mitigation |
|---|---|---|
| Compromission d'un autre workload du cluster | déplacement latéral vers PostgreSQL ou l'API | default-deny + politiques par composant (§9) ; PostgreSQL n'est jamais exposé par l'ingress ; `automountServiceAccountToken: false` |
| Compromission de la chaîne de build | image altérée poussée sous un tag existant | signature cosign keyless + admission Kyverno avec `mutateDigest` (§13) ; lockfile gelé ; SBOM attestée |
| Exfiltration par le pod applicatif | egress arbitraire vers Internet | egress limité à DNS, PostgreSQL, CIDR du LLM, 443 hors RFC1918 ; le pod add-in n'a **aucun** egress |
| Vol de secret via l'API Kubernetes | lecture de Secret depuis un pod | secrets montés en fichiers `0400`, pas de token de ServiceAccount monté, RBAC namespace |
| Administrateur cluster curieux | lecture du contenu des emails | rien n'est stocké en clair par défaut (hashes SHA-256, `AUDIT_STORE_CONTENT=false`) ; l'accès à la base est journalisé |
| Scrape non autorisé de `/metrics` | énumération d'activité (volumétrie par utilisateur) | `METRICS_TOKEN` obligatoire + NetworkPolicy limitant l'ingress au namespace de monitoring |
| Dérive de configuration (changement manuel en prod) | `kubectl edit` non tracé | `driftDetection: enabled` de Flux réapplique l'état du dépôt ; git est la source de vérité |
| Perte de disponibilité du GPU interne | le produit devient inutilisable | dégradation heuristique documentée, alerte `OaoLlmCircuitOpen`, aucune bascule vers un cloud public |

## 15. Localisation des données (data residency)

- **Tout reste dans le périmètre Northbridge** : le contenu des emails ne
  quitte jamais le couple « cluster NKP on-premise + GPU interne ». Aucun
  fournisseur d'IA public n'est appelé, dans aucun mode de fonctionnement
  (`llm.provider` ne connaît que `openai-compatible` — pointé vers l'endpoint
  interne — et `mock`).
- Les seuls flux sortants du cluster sont : l'endpoint LLM interne (réseau
  privé), PostgreSQL (dans le cluster ou base interne), et — uniquement si
  `graph.enabled=true` — Entra ID et Microsoft Graph, qui sont déjà les
  systèmes d'origine des emails traités. Aucune donnée n'est envoyée à un
  tiers qui ne la détenait pas déjà.
- Les sauvegardes restent dans le cluster (PVC) ou sur le stockage objet
  interne (Nutanix Objects) : `postgres.backup.s3.endpoint` doit pointer vers
  un endpoint interne, jamais vers un bucket cloud public.
- Les images et le chart sont hébergés sur GHCR : ils contiennent du **code**,
  jamais de données clients. Pour un cluster air-gapped, les miroiter sur le
  registre interne.
- Télémétrie : désactivée (`NEXT_TELEMETRY_DISABLED=1`) ; aucun appel
  analytics, aucun CDN externe dans le bundle de l'add-in.

## 16. Correspondance des contrôles (FINMA-friendly)

Tableau de correspondance entre les attentes usuelles d'un régulateur
financier suisse (FINMA 2018/3 sur l'externalisation, circulaires sur les
risques opérationnels et informatiques) et l'implémentation. Ce tableau
documente des **contrôles techniques** ; il ne remplace pas une revue
juridique.

| Domaine de contrôle | Attente | Implémentation | Preuve / vérification |
|---|---|---|---|
| Traçabilité des décisions | toute suggestion et toute action automatisée est journalisée et attribuable | `AuditEvent` obligatoire sur chaque chemin (invariant du projet), `correlationId` reliant log et audit | `GET /api/v1/audit`, export CSV, `oao_audit_events_total` |
| Contrôle humain (HITL) | pas d'exécution autonome d'action à impact | `requiresApproval` dès le risque `low`, `approvedBy` nominatif, `send`/`delete` hors périmètre | §4, §7, page *Approvals* du dashboard |
| Séparation des tâches | l'équipe compliance dispose d'un chemin décisionnel distinct | RBAC `user`/`compliance`/`admin` via app roles Entra ID, `compliance_escalated` → `compliance_decision` | §5, assignations Enterprise Applications |
| Moindre privilège (identité) | scopes strictement utilisés | aucun `Mail.Send`, aucun `*.All` délégué ; mode applicatif restreint par Exchange application access policy sur un groupe | `Test-ApplicationAccessPolicy` (`docs/SETUP.md` §4) |
| Moindre privilège (réseau) | cloisonnement des flux | NetworkPolicy default-deny + 8 politiques explicites | §9, `kubectl -n oao get networkpolicy` |
| Moindre privilège (exécution) | pas de privilèges superflus | non-root, rootfs en lecture seule, `capabilities: [ALL]` retirées, PSA `restricted` | manifests du chart |
| Minimisation des données | ne conserver que le nécessaire | hashes SHA-256 au lieu du contenu (`AUDIT_STORE_CONTENT=false`), métadonnées de pièces jointes seulement | §3 |
| Chiffrement en transit | TLS de bout en bout | HTTPS sur les 3 Ingress (cert-manager), TLS re-chiffré jusqu'au pod add-in, `sslmode=require` vers une base externe | `kubectl -n oao get certificate` |
| Chiffrement au repos | données persistantes chiffrées | chiffrement du datastore Nutanix (couche infrastructure) + `encryption at rest` etcd du cluster ; les sauvegardes héritent du même stockage | configuration Nutanix/NKP, hors périmètre applicatif |
| Conservation et suppression | durée définie, purge contrôlée et tracée | `AUDIT_RETENTION_DAYS`, `INDEX_RETENTION_DAYS` appliqués par le worker ; purge manuelle sous sauvegarde + export | §13 de `docs/OPERATIONS.md` |
| Continuité (BCM) | RPO/RTO définis et testés | sauvegarde quotidienne + snapshots, RPO ≤ 24 h / RTO ≤ 4 h documentés, test de restauration trimestriel | `docs/OPERATIONS.md` §9–10 |
| Gestion des changements | changements revus, traçables, réversibles | GitOps : tout changement est un commit revu ; `driftDetection` ; rollback Helm/Flux | historique git, `helm history` |
| Intégrité des livrables | provenance des artefacts déployés | signature cosign keyless, SBOM attestée, scan trivy bloquant, admission Kyverno | §11 |
| Détection et supervision | alertes techniques et métier | 9 règles Prometheus + dashboard Grafana + KPI d'audit | §4 de `docs/OPERATIONS.md` |
| Gestion des vulnérabilités | veille et correction | Dependabot (npm/actions/docker), CodeQL, trivy en release | PR Dependabot, onglet Security |
| Localisation des données | pas de transfert hors périmètre | modèle IA interne, aucun fournisseur cloud d'IA | §13 |
| Gestion des accès privilégiés | accès admin restreint et auditable | *Assignment required* sur l'app dashboard, groupes dédiés, actions admin auditées | Entra ID + audit |

Points à porter explicitement au dossier de conformité, car **non couverts**
par ce dépôt : chiffrement au repos (propriété de la plateforme Nutanix),
gestion des identités et revue périodique des accès (processus Entra ID),
et la revue juridique de l'usage de l'IA sur des données clients.

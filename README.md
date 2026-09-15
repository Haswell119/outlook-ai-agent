# Outlook AI Orchestrator

> Secure. Compliant. Human-in-the-loop.
> Longbow Finance SA — compétition IA interne. Tech Lead : **Justin Vuffray**.
> Product/PM : **Luanda Borg**.

Un add-in Outlook (volet latéral) qui permet à l'utilisateur de **discuter
avec sa boîte mail** : résumés instantanés, décisions et tâches, risques,
recherche conversationnelle avec sources citées, synthèse de fil de
discussion, brouillons de réponse (jamais envoyés par l'IA), actions
proposées validées par l'utilisateur (human-in-the-loop), un **Automation
Coach** (détection de routines → proposition → simulation → activation) et un
**Compliance Guardian** (vérifications avant envoi + anti-phishing entrant).
Tout est audité et supervisé depuis un dashboard admin.

Le modèle IA est **hébergé en interne** (GPU Longbow, Qwen3 aujourd'hui).
L'orchestrator lui parle via une **API HTTP compatible OpenAI** (vLLM,
Ollama, LM Studio, TGI, Azure OpenAI privé…). Changer de modèle = changer des
variables d'environnement, aucun changement de code.

## Architecture

```
┌───────────────────────┐  HTTPS    ┌──────────────────────────────┐  HTTP(S)   ┌──────────────────────┐
│ Outlook (desktop/web)  │ ───────►  │  AI Orchestrator (Fastify)   │ ─────────► │  Modèle IA interne    │
│  add-in — task pane    │ ◄───────  │  /api/v1/*                   │ ◄───────── │  (compatible OpenAI)  │
│  React + Office.js     │           │  auth · policy · prompts ·   │            │  ex: vLLM + Qwen3      │
└────────────┬───────────┘           │  risque · actions · audit    │            └──────────────────────┘
             │ jeton SSO Office      │                               │  OBO       ┌──────────────────────┐
             │ (Azure AD)            │  PostgreSQL + pgvector        │ ─────────► │  Microsoft Graph      │
┌────────────┴───────────┐           └──────────────┬────────────────┘            │  (optionnel, phase 2+)│
│ Admin dashboard         │ ─────────────────────────┘  /audit, /automations,     └──────────────────────┘
│ Next.js + shadcn/ui     │      /compliance, /admin
└─────────────────────────┘
```

Deux chemins pour lire les emails :

1. **Office.js (par défaut, jour 1)** : l'add-in lit l'item ouvert et le
   POST à l'orchestrator — aucune permission Graph nécessaire.
2. **Microsoft Graph (optionnel, `GRAPH_ENABLED=true`)** : l'orchestrator
   échange le jeton SSO Office contre un jeton Graph (On-Behalf-Of) pour
   indexer la boîte, créer des tâches/rappels, déplacer des messages.

Détail complet : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Structure du monorepo

```
outlook-ai-agent/
├── apps/
│   ├── addin/          # Add-in Outlook — React 18 + TypeScript + Vite + Office.js (Fluent UI v9)
│   ├── orchestrator/   # AI Orchestrator — Node 20 + Fastify 5 + PostgreSQL (pgvector) + zod
│   └── admin/           # Dashboard admin — Next.js (App Router) + Tailwind + shadcn/ui + Recharts
├── packages/
│   └── shared/          # @oao/shared — contrats zod + types + table de routes (source unique de vérité)
├── infra/
│   ├── docker/           # Dockerfiles, docker-compose (postgres+pgvector, orchestrator, admin, addin nginx)
│   └── k8s/               # Manifests Kubernetes (Deployments, Services, Ingress, ConfigMap, Secret templates)
├── scripts/               # dev-up/down, cert dev, sideload manifest, check-llm, smoke-test
├── .github/workflows/     # CI (build, typecheck, tests, secret scan, docker build)
└── docs/                  # Architecture, setup, catalogue d'actions, sécurité, API, runbook
```

Packages : `@oao/shared`, `@oao/orchestrator`, `@oao/addin`, `@oao/admin`.

## Démarrage rapide (démo en 5 minutes)

Aucune dépendance externe requise : LLM mocké, base en mémoire.

```bash
git clone <repo-url> outlook-ai-agent
cd outlook-ai-agent
corepack enable && corepack prepare pnpm@10.33.0 --activate
./scripts/dev-up.sh          # copie .env.example -> .env, installe, build @oao/shared
pnpm --filter @oao/addin certs   # certificat HTTPS local pour l'add-in
pnpm dev                     # orchestrator :8080, addin :3000, admin :3001
./scripts/smoke-test.sh      # vérifie que tout répond
```

Puis sideloader `apps/addin/manifest/manifest.dev.xml` dans Outlook — voir
[`docs/SETUP.md`](docs/SETUP.md) §7 (`scripts/sideload-manifest.ps1` pour
Outlook desktop classique sur Windows).

Pour la stack complète (Postgres + modèle IA interne réel) ou un déploiement
Docker/Kubernetes, voir [`docs/SETUP.md`](docs/SETUP.md).

## Documentation

| Document | Contenu |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture technique détaillée (source de référence du projet) |
| [`docs/SETUP.md`](docs/SETUP.md) | Installation, IA interne (vLLM/Ollama/TGI/Azure OpenAI), Azure AD, sideload, déploiement Docker/K8s |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Runbook : logs, health, métriques, secrets, sauvegardes, comportement dégradé, incidents |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Modèle de menace, minimisation des données, RBAC, conformité, matrice de gouvernance, scopes Graph |
| [`docs/ACTIONS.md`](docs/ACTIONS.md) | Catalogue des types d'action IA, cible d'exécution, risque, instruction client |
| [`docs/API.md`](docs/API.md) | Table des endpoints, rôles requis, schémas, exemples curl |
| [`docs/mockups.md`](docs/mockups.md) | Référence visuelle des écrans (add-in + dashboard) |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branches, convention de commit, Definition of Done |

## Statut des phases

| Phase | Fonctionnalités | Statut |
|---|---|---|
| 1 | Résumé/décisions/tâches/risques, brouillon de réponse (non envoyé), journal d'audit, scaffold add-in | ✅ dans ce repo |
| 2 | Actions validées (human-in-the-loop), recherche conversationnelle, synthèse de fil | ✅ dans ce repo |
| 3 | Chat multi-emails, auto-catégorisation, Automation Coach + simulation | ✅ dans ce repo |
| 4 | Vérifications de conformité avant envoi, analyse de pièces jointes (texte), anti-phishing, dashboard | ✅ dans ce repo |

## Crédits

**Longbow Finance SA** — Tech Lead : Justin Vuffray · Product/PM : Luanda Borg.

# Outlook AI Orchestrator

[![CI](https://github.com/northbridge-capital/outlook-ai-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/northbridge-capital/outlook-ai-agent/actions/workflows/ci.yml)
[![CodeQL](https://github.com/northbridge-capital/outlook-ai-agent/actions/workflows/codeql.yml/badge.svg)](https://github.com/northbridge-capital/outlook-ai-agent/actions/workflows/codeql.yml)
[![Release](https://github.com/northbridge-capital/outlook-ai-agent/actions/workflows/release.yml/badge.svg)](https://github.com/northbridge-capital/outlook-ai-agent/actions/workflows/release.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-339933)
![Kubernetes](https://img.shields.io/badge/deploy-NKP%20%2B%20Flux-1f7fc0)

> Secure. Compliant. Human-in-the-loop.
> Northbridge Capital — compétition IA interne.

Un add-in Outlook (volet latéral) qui permet à l'utilisateur de **discuter
avec sa boîte mail** : résumés instantanés, décisions et tâches, risques,
recherche conversationnelle avec sources citées, synthèse de fil de
discussion, brouillons de réponse (jamais envoyés par l'IA), actions proposées
validées par l'utilisateur (human-in-the-loop), un **Automation Coach**
(détection de routines → proposition → simulation → activation) et un
**Compliance Guardian** (vérifications avant envoi + anti-phishing entrant).
Tout est audité et supervisé depuis un dashboard admin.

Le modèle IA est **hébergé en interne** (GPU Northbridge, Qwen3 aujourd'hui).
L'orchestrator lui parle via une **API HTTP compatible OpenAI** (vLLM, Ollama,
LM Studio, TGI, Azure OpenAI privé…). Changer de modèle = changer des
variables d'environnement, aucun changement de code.

## Statut : production-ready

Ce dépôt ne contient pas seulement une démo : les trois applications sont
durcies pour la production et le packaging de déploiement complet pour
**Nutanix Kubernetes Platform (NKP)** est fourni, dimensionné pour
50 utilisateurs.

Ce que cela veut dire concrètement : configuration validée au démarrage
(échec immédiat et exhaustif si elle est incomplète), probes Kubernetes
distinctes liveness/readiness, métriques Prometheus et alertes livrées,
secrets montés en fichiers, audit de chaque réponse IA, rétention appliquée par
un worker, idempotence des approbations, et minimisation active de la charge
GPU (triage heuristique, caches par hash de contenu, précalcul, routage
deux modèles — [`AI_LOAD.md`](apps/orchestrator/docs/AI_LOAD.md)).

### Ce que l'opérateur doit configurer

| # | À renseigner | Où |
|---|---|---|
| 1 | **Modèle interne** : `LLM_BASE_URL`, `LLM_MODEL`, `LLM_FAST_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `LLM_API_KEY` (si exigée) | `llm.*` du chart · validé par `pnpm check:llm` |
| 2 | **Entra ID** : trois app registrations (API avec `access_as_user` + app roles `Admin`/`Compliance`, add-in SSO, dashboard) | [`docs/SETUP.md`](docs/SETUP.md) §3 |
| 3 | **Noms DNS + TLS** des trois hôtes (`api`, `admin`, `addin`) et CA interne distribuée aux postes | `hosts.*`, `ingress.tls.*`, `addin.tls.*` |
| 4 | **Secrets** : `AAD_CLIENT_SECRET`, `ADMIN_API_TOKEN` (≥ 24 car.), `METRICS_TOKEN`, `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `POSTGRES_PASSWORD`/`DATABASE_URL` | SOPS ou External Secrets, montés en `<NOM>_FILE` |
| 5 | **Graph** (si précalcul) : permission applicative consentie + Exchange application access policy sur un groupe mail-enabled, `graph.sync.groupId` | [`docs/SETUP.md`](docs/SETUP.md) §4 |
| 6 | **Réseau** : CIDR du nœud GPU (`llm.egress.cidrs`), namespaces Traefik et Prometheus | `networkPolicy.*` |
| 7 | **Sauvegardes** activées **et restauration testée**, alertes routées vers l'astreinte | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §9 et §4 |

Go-live : dérouler [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md).

| | |
|---|---|
| **Packaging** | chart Helm unique (`infra/helm/outlook-ai-orchestrator`) : API + worker, dashboard, add-in, PostgreSQL/pgvector, HPA, PDB, NetworkPolicies default-deny, Job de migration, CronJob de sauvegarde |
| **Livraison** | GitOps avec Flux (fourni par Kommander) : `infra/gitops`, un `HelmRelease` par environnement, secrets chiffrés SOPS ou External Secrets |
| **Chaîne d'approvisionnement** | images GHCR signées **cosign keyless**, SBOM SPDX attestée, scan **trivy** bloquant sur `CRITICAL`, chart publié en artefact OCI signé |
| **Observabilité** | `ServiceMonitor` + 9 règles d'alerte Prometheus + dashboard Grafana livrés avec le chart |
| **Sécurité** | non-root, rootfs en lecture seule, secrets montés en fichiers (`<NOM>_FILE`), PSA `restricted`, tout le trafic est-ouest fermé par défaut |
| **Multi-OS** | outillage développeur 100 % Node ESM : les mêmes commandes `pnpm` sur Windows, macOS et Linux — ni bash, ni `curl`, ni WSL |

Déploiement pas-à-pas : [`docs/NKP.md`](docs/NKP.md) ·
Checklist de go-live : [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md).

## Architecture

```
┌───────────────────────┐  HTTPS    ┌──────────────────────────────┐  HTTP(S)   ┌──────────────────────┐
│ Outlook (desktop/web)  │ ───────►  │  AI Orchestrator (Fastify)   │ ─────────► │  Modèle IA interne    │
│  add-in — task pane    │ ◄───────  │  ROLE=api  /api/v1/*         │ ◄───────── │  (compatible OpenAI)  │
│  React + Office.js     │           │  auth · policy · prompts ·   │            │  ex: vLLM + Qwen3      │
└────────────┬───────────┘           │  risque · actions · audit    │            └──────────────────────┘
             │ jeton SSO Office      │  ROLE=worker  sync · brief   │  OBO       ┌──────────────────────┐
             │ (Entra ID)            │  PostgreSQL + pgvector       │ ─────────► │  Microsoft Graph      │
┌────────────┴───────────┐           └──────────────┬───────────────┘            │  (optionnel)          │
│ Admin dashboard         │ ─────────────────────────┘  /audit, /automations,    └──────────────────────┘
│ Next.js + shadcn/ui     │      /compliance, /admin
└─────────────────────────┘
```

Deux chemins pour lire les emails :

1. **Office.js (par défaut, jour 1)** : l'add-in lit l'item ouvert et le POST à
   l'orchestrator — aucune permission Graph nécessaire.
2. **Microsoft Graph (optionnel)** : jeton échangé On-Behalf-Of, ou permissions
   applicatives restreintes par une *Exchange application access policy* limitée
   à un groupe de sécurité, pour le worker de précalcul.

Détail complet : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (§10 pour la
topologie de déploiement NKP).

## Structure du monorepo

```
outlook-ai-agent/
├── apps/
│   ├── addin/          # Add-in Outlook — React 18 + TypeScript + Vite + Office.js (Fluent UI v9)
│   ├── orchestrator/   # AI Orchestrator — Node 22 + Fastify 5 + PostgreSQL (pgvector) + zod
│   └── admin/          # Dashboard admin — Next.js (App Router) + Tailwind + shadcn/ui + Recharts
├── packages/
│   └── shared/         # @oao/shared — contrats zod + types + table de routes (source unique de vérité)
├── infra/
│   ├── helm/           # Chart de production (source de vérité du déploiement) + values-nkp.yaml
│   ├── gitops/         # Flux : sources, HelmRelease par environnement, SOPS, image automation
│   ├── docker/         # Dockerfiles multi-stage non-root, nginx, init PostgreSQL
│   └── k8s/            # Manifests GÉNÉRÉS depuis le chart (pnpm k8s:render), pour les clusters sans Helm
├── scripts/            # Outillage développeur en Node ESM (multi-OS)
├── .github/workflows/  # CI, release (images + chart OCI signés), CodeQL
└── docs/               # Architecture, setup, NKP, runbook, sécurité, actions, API
```

## Démarrage rapide (démo en 5 minutes)

Aucune dépendance externe : LLM mocké, base en mémoire. Identique sur Windows,
macOS et Linux.

```bash
git clone <repo-url> outlook-ai-agent
cd outlook-ai-agent
corepack enable && corepack prepare pnpm@10.33.0 --activate

pnpm setup:dev      # .env, vérifications, install, build @oao/shared
pnpm certs          # certificat HTTPS local (Office exige HTTPS)
pnpm dev            # orchestrator :8080 · addin :3000 · admin :3001
pnpm smoke          # vérifie que tout répond
```

Puis charger le volet dans Outlook :

```bash
pnpm manifest:sideload      # registre Windows, dossier wef macOS, ou instructions OWA
```

Détails et stack complète (PostgreSQL + modèle interne) :
[`docs/SETUP.md`](docs/SETUP.md) §9.

## Commandes utiles

| Commande | Effet |
|---|---|
| `pnpm setup:dev` | bootstrap complet de l'environnement de dev |
| `pnpm dev:db [up\|down\|reset\|psql]` | PostgreSQL/pgvector local |
| `pnpm check:llm` | valide l'endpoint LLM interne (models, chat, embeddings) |
| `pnpm smoke` | test de bout en bout contre un orchestrator en marche |
| `pnpm manifest:render` | rend les manifests Office pour un environnement |
| `pnpm manifest:sideload` | charge le volet dans Outlook (multi-OS) |
| `pnpm k8s:render` | régénère `infra/k8s/rendered/` depuis le chart Helm |
| `pnpm typecheck` · `lint` · `test` · `e2e` · `build` | qualité |

Toutes acceptent `--help`.

## Documentation

| Document | Contenu |
|---|---|
| [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) | **Checklist de mise en production** : Entra ID, DNS/TLS, secrets, endpoint IA, politique Graph, réseau, sauvegardes, alertes, pilote, rollback |
| [`docs/NKP.md`](docs/NKP.md) | **Déploiement production** sur Nutanix Kubernetes Platform, pas à pas |
| [`docs/SETUP.md`](docs/SETUP.md) | Installation (prod → Docker → local), Entra ID, Graph, DNS/certificats, manifests M365 |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Runbook : métriques, alertes, upgrades, rollback, sauvegardes, DR, capacité |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Modèle de menace, NetworkPolicies, secrets, signature d'images, contrôles FINMA |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture technique détaillée (§5 add-in, §6 dashboard, §8 configuration complète, §10 déploiement NKP) |
| [`apps/orchestrator/docs/AI_LOAD.md`](apps/orchestrator/docs/AI_LOAD.md) | Minimisation de la charge IA : les sept leviers, dimensionnement GPU |
| [`docs/ACTIONS.md`](docs/ACTIONS.md) | Catalogue des types d'action IA, cible d'exécution, risque |
| [`docs/API.md`](docs/API.md) | Endpoints, rôles requis, schémas, exemples |
| [`docs/mockups.md`](docs/mockups.md) | Référence visuelle des écrans |
| [`infra/helm/outlook-ai-orchestrator/README.md`](infra/helm/outlook-ai-orchestrator/README.md) | Valeurs du chart, stratégies de secrets, observabilité |
| [`infra/gitops/README.md`](infra/gitops/README.md) | Flux, SOPS/age, attachement dans Kommander, cycle de vie |
| [`infra/docker/README.md`](infra/docker/README.md) | Images, builds, propriétés de sécurité |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branches, commits, Definition of Done |

## Statut des phases

| Phase | Fonctionnalités | Statut |
|---|---|---|
| 1 | Résumé/décisions/tâches/risques, brouillon de réponse (non envoyé), journal d'audit, scaffold add-in | ✅ |
| 2 | Actions validées (human-in-the-loop), recherche conversationnelle, synthèse de fil | ✅ |
| 3 | Chat multi-emails, auto-catégorisation, Automation Coach + simulation | ✅ |
| 4 | Vérifications de conformité avant envoi, analyse de pièces jointes, anti-phishing, dashboard | ✅ |
| — | Packaging production NKP (Helm, GitOps, supply chain, observabilité) | ✅ |
| — | Durcissement production des trois applications (probes, métriques, caches, sync worker, RBAC dashboard, CSP) | ✅ |

## Crédits

**Northbridge Capital** — compétition IA interne.

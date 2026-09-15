# Guide d'installation — Outlook AI Orchestrator

> Ce document explique comment installer, configurer et déployer le projet,
> du mode démo (5 minutes, sans dépendance externe) jusqu'à la production
> (Docker / Kubernetes, IA interne Northbridge, Azure AD). Les termes techniques
> (endpoints, variables d'environnement, commandes) sont laissés en anglais.

## Sommaire

1. [Prérequis](#1-prérequis)
2. [Installation](#2-installation)
3. [Lancement en mode démo (5 minutes)](#3-lancement-en-mode-démo-5-minutes)
4. [Lancement complet (Postgres + modèle interne)](#4-lancement-complet-postgres--modèle-interne)
5. [Configuration de l'IA interne](#5-configuration-de-lia-interne)
6. [Azure AD App Registration](#6-azure-ad-app-registration)
7. [Sideload de l'add-in](#7-sideload-de-ladd-in)
8. [Déploiement centralisé M365 (Integrated Apps)](#8-déploiement-centralisé-m365-integrated-apps)
9. [Déploiement Docker](#9-déploiement-docker)
10. [Déploiement Kubernetes](#10-déploiement-kubernetes)
11. [Checklist de mise en production](#11-checklist-de-mise-en-production)

---

## 1. Prérequis

| Outil | Version | Usage |
|---|---|---|
| Node.js | ≥ 20 | runtime des trois apps |
| pnpm | 10.33.0 (via corepack) | gestionnaire de monorepo |
| Docker + Docker Compose | récent | Postgres local, images de prod |
| Git | — | — |
| PowerShell 5+ | Windows | `scripts/sideload-manifest.ps1` |
| mkcert (optionnel) | — | certificat HTTPS local sans avertissement navigateur |
| kubectl + kustomize | récent | déploiement Kubernetes |

Activer pnpm :

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

## 2. Installation

```bash
git clone <repo-url> outlook-ai-agent
cd outlook-ai-agent
cp .env.example .env
pnpm install
pnpm --filter @oao/shared build   # @oao/shared doit être compilé en premier
```

Ou, plus simple, tout en un :

```bash
./scripts/dev-up.sh
```

`dev-up.sh` copie `.env.example` → `.env` si absent, démarre Postgres via
`docker-compose.dev.yml`, installe les dépendances et build `@oao/shared`.

## 3. Lancement en mode démo (5 minutes)

Le mode démo ne nécessite **ni Postgres ni modèle IA** : l'orchestrator tourne
en mémoire avec un provider LLM déterministe (mock).

Dans `.env` :

```bash
LLM_PROVIDER=mock
DATABASE_URL=memory
AUTH_MODE=dev
```

Puis :

```bash
pnpm dev
```

Cela démarre en parallèle :

- **orchestrator** → http://localhost:8080 (health check : `GET /api/v1/health`)
- **addin** → https://localhost:3000 (nécessite un certificat HTTPS local, voir
  ci-dessous)
- **admin** → http://localhost:3001

Générer le certificat HTTPS local pour l'add-in (une fois) :

```bash
pnpm --filter @oao/addin certs
# ou : ./scripts/gen-dev-cert.sh
```

Vérifier que tout fonctionne :

```bash
./scripts/smoke-test.sh
```

Puis sideloader `apps/addin/manifest/manifest.dev.xml` dans Outlook (voir
§7).

## 4. Lancement complet (Postgres + modèle interne)

```bash
# 1. Postgres (pgvector)
docker compose -f docker-compose.dev.yml up -d

# 2. .env
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://gpu-node.northbridge.local:8000/v1
LLM_MODEL=qwen3-30b-a3b
DATABASE_URL=postgres://oao:oao@localhost:5432/oao
DB_AUTO_MIGRATE=true

# 3. Migrations + seed (si DB_AUTO_MIGRATE=false)
pnpm --filter @oao/orchestrator db:migrate
pnpm --filter @oao/orchestrator db:seed

# 4. Vérifier le modèle IA interne
./scripts/check-llm.sh

# 5. Lancer
pnpm dev
```

## 5. Configuration de l'IA interne

L'orchestrator parle à n'importe quel serveur **compatible OpenAI**
(`/v1/chat/completions`, `/v1/embeddings`). Changer de modèle = changer les
variables `LLM_*` / `EMBEDDING_*` dans `.env`, aucun changement de code.

### vLLM (recommandé, Qwen3, 2 GPU)

```bash
# Chat model — quantifié AWQ (ou GPTQ), servi sous un nom stable
vllm serve Qwen/Qwen3-30B-A3B-Instruct-AWQ \
  --served-model-name qwen3-30b-a3b \
  --quantization awq \
  --tensor-parallel-size 2 \
  --max-model-len 16384 \
  --host 0.0.0.0 --port 8000

# Variante GPTQ
vllm serve Qwen/Qwen3-30B-A3B-Instruct-GPTQ \
  --served-model-name qwen3-30b-a3b \
  --quantization gptq \
  --tensor-parallel-size 2 \
  --max-model-len 16384 \
  --host 0.0.0.0 --port 8000
```

Embeddings (`bge-m3`), sur un port dédié via vLLM en mode `--task embed` :

```bash
vllm serve BAAI/bge-m3 \
  --task embed \
  --served-model-name bge-m3 \
  --host 0.0.0.0 --port 8001
```

Ou via **Text Embeddings Inference (TEI)** (souvent plus rapide pour de
l'embedding pur) :

```bash
docker run --gpus all -p 8001:80 \
  ghcr.io/huggingface/text-embeddings-inference:latest \
  --model-id BAAI/bge-m3
```

`.env` correspondant :

```bash
LLM_BASE_URL=http://gpu-node.northbridge.local:8000/v1
LLM_MODEL=qwen3-30b-a3b
EMBEDDINGS_ENABLED=true
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIMENSIONS=1024
```

> Si `/v1/embeddings` de vLLM et le chat ne sont pas exposés sur le même port
> (deux serveurs distincts, cas ci-dessus), l'orchestrator suppose un seul
> `LLM_BASE_URL` pour les deux : exposer les deux derrière un reverse-proxy
> interne unique (nginx/traefik) qui route `/v1/chat/completions` vers le
> serveur chat et `/v1/embeddings` vers le serveur embeddings, ou déployer les
> deux sur le même processus vLLM si la version le permet.

### Ollama (alternative simple, dev/POC)

```bash
ollama pull qwen3
ollama serve   # expose /v1 en OpenAI-compatible sur :11434
```

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3
```

Limite connue : toutes les versions d'Ollama n'exposent pas `/v1/embeddings`
pour tous les modèles — préférer vLLM/TEI pour `bge-m3` si la recherche
sémantique est nécessaire.

### TGI (Text Generation Inference)

```bash
docker run --gpus all -p 8000:80 \
  ghcr.io/huggingface/text-generation-inference:latest \
  --model-id Qwen/Qwen3-30B-A3B-Instruct --max-input-length 16000
```

TGI expose une API OpenAI-compatible sous `/v1` depuis les versions récentes ;
vérifier `LLM_JSON_MODE=prompt` si le mode JSON natif (`response_format`)
n'est pas supporté par la version déployée.

### Azure OpenAI (tenant privé)

```bash
LLM_BASE_URL=https://<resource>.openai.azure.com/openai/deployments/<deployment>
LLM_API_KEY=<clé Azure OpenAI>
LLM_MODEL=<nom du déploiement>
```

### Valider la configuration

```bash
./scripts/check-llm.sh
```

Le script teste `/models`, une complétion de chat, et `/embeddings` si
`EMBEDDING_MODEL` est renseigné, et affiche un verdict **OK/KO** clair par
étape.

## 6. Azure AD App Registration

Nécessaire pour `AUTH_MODE=aad` (SSO Office) et, en phase 2+, pour le chemin
Microsoft Graph (`GRAPH_ENABLED=true`).

### 6.1 Créer l'App Registration (API — l'orchestrator)

1. Azure Portal → **Azure Active Directory** → **App registrations** → **New
   registration**.
2. Nom : `Outlook AI Orchestrator — API`. Comptes pris en charge : *single
   tenant* (Northbridge uniquement).
3. Après création, noter **Application (client) ID** → `AAD_CLIENT_ID`, et
   **Directory (tenant) ID** → `AAD_TENANT_ID`.
4. **Expose an API** :
   - Definir l'**Application ID URI** (ex. `api://oao-orchestrator`).
   - **Add a scope** : nom `access_as_user`, *Who can consent* = Admins and
     users, description courte, état **Enabled**.
5. **Certificates & secrets** → **New client secret** (nécessaire pour l'échange
   On-Behalf-Of vers Graph) → copier la valeur dans `AAD_CLIENT_SECRET`
   (jamais en clair dans un fichier commité — secret manager en prod).
6. **App roles** (optionnel mais recommandé plutôt que `ADMIN_EMAILS` /
   `COMPLIANCE_EMAILS`) : créer `admin` et `compliance` (type *Users/Groups*),
   puis assigner les utilisateurs/groupes dans **Enterprise applications** →
   l'app → **Users and groups**.

### 6.2 Créer l'App Registration du add-in (SPA)

1. **New registration** → nom `Outlook AI Orchestrator — Add-in`.
2. **Authentication** → **Add a platform** → **Single-page application** →
   redirect URIs :
   - `https://localhost:3000` (dev)
   - `https://addin.northbridge.local` (prod, ou le domaine réel de déploiement)
3. **API permissions** → **Add a permission** → **My APIs** → sélectionner
   l'app *Outlook AI Orchestrator — API* → cocher `access_as_user`.
4. Ajouter les permissions **Microsoft Graph** (déléguées), en respectant le
   principe du moindre privilège et la montée en charge par phase :
   - Phase 1 : `Mail.Read`
   - Phase 2+ : `Mail.ReadWrite`, `Tasks.ReadWrite`, `Calendars.ReadWrite`
   - Toujours : `offline_access` (rafraîchissement du token pour l'OBO côté
     orchestrator)
5. **Grant admin consent** pour le tenant (bouton *Grant admin consent for
   Northbridge*) — requis pour que tous les utilisateurs puissent utiliser
   l'add-in sans popup de consentement individuel. Voir la justification de
   chaque scope dans `docs/SECURITY.md`.
6. Dans le manifest de l'add-in (`apps/addin/manifest/manifest.xml` /
   `manifest.dev.xml`), configurer le bloc `WebApplicationInfo` :

   ```xml
   <WebApplicationInfo>
     <Id>{AAD_CLIENT_ID de l'App Registration du add-in}</Id>
     <Resource>api://oao-orchestrator</Resource>
     <Scopes>
       <Scope>access_as_user</Scope>
     </Scopes>
   </WebApplicationInfo>
   ```

## 7. Sideload de l'add-in

### Outlook desktop — classique (Win32)

```powershell
.\scripts\sideload-manifest.ps1
```

Le script enregistre le dossier du manifest dans
`HKCU\Software\Microsoft\Office\16.0\WEF\Developer`, redémarrer Outlook puis
**Accueil → Obtenir des compléments → Mes compléments**.

### Outlook desktop — New Outlook (Windows)

New Outlook ne lit pas la clé de registre WEF. Depuis New Outlook :
**Paramètres (roue dentée) → Compléments → Mes compléments → Compléments
personnalisés → Ajouter un complément personnalisé → Ajouter à partir d'un
fichier**, sélectionner `manifest/manifest.dev.xml`.

### Outlook sur le web (OWA)

Même chemin que New Outlook : **Paramètres → Gérer les compléments → Mes
compléments → Compléments personnalisés → Ajouter à partir d'un fichier** (ou
*Ajouter à partir d'une URL* en pointant vers
`https://localhost:3000/manifest.dev.xml` si le serveur dev le sert).

Prérequis commun : le serveur dev (`https://localhost:3000`) doit être
démarré (`pnpm --filter @oao/addin dev`) et son certificat TLS doit être fiable
(voir §3, `scripts/gen-dev-cert.sh` ou `pnpm --filter @oao/addin certs`).

## 8. Déploiement centralisé M365 (Integrated Apps)

Pour déployer l'add-in à toute l'organisation sans sideload manuel :

1. **Microsoft 365 admin center** → **Settings** → **Integrated apps** →
   **Upload custom apps**.
2. Uploader `apps/addin/manifest/manifest.xml` (le manifest de **production**,
   avec `https://addin.northbridge.local` déjà remplacé par le domaine réel —
   voir §9/§10 pour l'hébergement).
3. Choisir les utilisateurs/groupes cibles (déploiement pilote recommandé
   avant un rollout complet).
4. Valider les permissions Graph demandées (correspondent au manifest et à
   l'App Registration du §6.2) — l'admin consent donné en §6.2 couvre déjà ces
   permissions.
5. Le déploiement peut prendre jusqu'à 24h pour se propager à tous les
   clients Outlook.

## 9. Déploiement Docker

```bash
cp .env.example .env   # éditer LLM_*, AAD_*, ADMIN_API_TOKEN, POSTGRES_PASSWORD
docker compose up --build -d
docker compose ps
curl http://localhost:8080/api/v1/health
```

Services démarrés : `postgres` (pgvector, healthcheck), `orchestrator`
(migrations auto si `DB_AUTO_MIGRATE=true`), `admin` (:3001), `addin` (nginx
HTTPS :3000, certificat auto-signé généré au démarrage si aucun n'est monté
dans `apps/addin/certs/`).

Voir `infra/docker/` pour le détail des Dockerfiles et `docker-compose.yml`
pour le profil optionnel `llm` (vLLM/Ollama locaux, utile en démo — Northbridge
dispose déjà de Qwen3 en interne, ce profil n'est pas nécessaire en usage
normal).

## 10. Déploiement Kubernetes

```bash
# 1. Namespace + config
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/configmap.yaml

# 2. Secrets (ne jamais committer les vraies valeurs — copier le template)
cp infra/k8s/secret.example.yaml infra/k8s/secret.local.yaml
# éditer infra/k8s/secret.local.yaml avec les vraies valeurs
kubectl apply -f infra/k8s/secret.local.yaml

# 3. Tout le reste via kustomize (namespace + configmap déjà appliqués plus haut,
#    kustomize peut aussi les gérer directement si secret.local.yaml est ajouté
#    à kustomization.yaml localement)
kubectl apply -k infra/k8s

# 4. Migrations + seed
kubectl -n oao wait --for=condition=ready pod -l app=postgres --timeout=180s
kubectl apply -f infra/k8s/job-migrate.yaml
kubectl -n oao wait --for=condition=complete job/oao-migrate --timeout=300s

# 5. Vérifier
kubectl -n oao get pods,svc,ingress
curl https://api.oao.northbridge.local/api/v1/health
```

Notes :

- Le `postgres-statefulset.yaml` est prévu pour le **non-prod** uniquement
  (dev/staging sans base managée) — en production, pointer `DATABASE_URL`
  (dans le Secret) vers une instance PostgreSQL managée avec l'extension
  `vector` disponible, et retirer le StatefulSet de `kustomization.yaml`.
- L'Ingress attend un `IngressClass` nginx et un secret TLS `oao-tls-cert`
  (cert-manager recommandé) pour `api.oao.northbridge.local`,
  `admin.oao.northbridge.local`, `addin.oao.northbridge.local`.
- Valider la structure des manifests sans cluster : `kubectl kustomize
  infra/k8s` (ou un parseur YAML si `kubectl` est indisponible).

## 11. Checklist de mise en production

- [ ] `.env` / Secrets K8s remplis avec de vraies valeurs, **aucun secret en
      clair** dans le repo (voir `docs/SECURITY.md`).
- [ ] `AUTH_MODE=aad` (le mode `dev` est refusé si `NODE_ENV=production`).
- [ ] Azure AD : admin consent donné, scopes Graph limités à ceux réellement
      utilisés par la phase déployée (§6).
- [ ] `LLM_BASE_URL` pointe vers l'endpoint interne Northbridge validé par
      `./scripts/check-llm.sh`.
- [ ] Migrations appliquées (`job-migrate.yaml` ou `db:migrate` + `db:seed`).
- [ ] `CORS_ORIGINS` restreint au(x) domaine(s) réel(s) de l'add-in.
- [ ] Certificats TLS réels (pas auto-signés) sur l'Ingress / le service addin.
- [ ] `AUDIT_STORE_CONTENT=false` sauf besoin explicite et validé
      (minimisation des données, voir `docs/SECURITY.md`).
- [ ] Sauvegardes Postgres planifiées (voir `docs/OPERATIONS.md`).
- [ ] CI verte (`pnpm build`, tests, secret-scan) sur la branche déployée.
- [ ] Manifest de production (`manifest.xml`) déployé via Integrated Apps
      (§8), avec les vrais domaines (plus de `*.northbridge.local`).
- [ ] Runbook `docs/OPERATIONS.md` et matrice de gouvernance
      `docs/SECURITY.md` relus par l'équipe compliance.

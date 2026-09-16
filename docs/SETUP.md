# Guide d'installation — Outlook AI Orchestrator

> De la production vers le poste de développeur : ce document décrit d'abord
> le déploiement de production (NKP + GitOps), puis le déploiement Docker, puis
> le mode démo local. Les termes techniques (endpoints, variables
> d'environnement, commandes) restent en anglais.
>
> Toutes les commandes `pnpm …` fonctionnent à l'identique sur **Windows,
> macOS et Linux** : l'outillage est en Node ESM (`scripts/*.mjs`), il n'y a
> plus de script bash ni de dépendance à `curl`.

## Sommaire

1. [Choisir son chemin d'installation](#1-choisir-son-chemin-dinstallation)
2. [Production — NKP + GitOps](#2-production--nkp--gitops)
3. [Entra ID (Azure AD) — les trois app registrations](#3-entra-id-azure-ad--les-trois-app-registrations)
4. [Microsoft Graph et le worker de précalcul](#4-microsoft-graph-et-le-worker-de-précalcul)
5. [DNS et certificats](#5-dns-et-certificats)
6. [Déploiement centralisé du manifest (Microsoft 365)](#6-déploiement-centralisé-du-manifest-microsoft-365)
7. [Configuration de l'IA interne](#7-configuration-de-lia-interne)
8. [Déploiement Docker](#8-déploiement-docker)
9. [Développement local](#9-développement-local)
10. [Sideload de l'add-in](#10-sideload-de-laddin)
11. [Checklist de mise en production](#11-checklist-de-mise-en-production) — version complète : [`PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md)

---

## 1. Choisir son chemin d'installation

| Chemin | Pour qui | Point d'entrée |
|---|---|---|
| **NKP + Flux (GitOps)** | production Northbridge, 50 utilisateurs | [`NKP.md`](NKP.md) + §2 ci-dessous |
| **Helm seul** | cluster de test, bootstrap | [`../infra/helm/outlook-ai-orchestrator/README.md`](../infra/helm/outlook-ai-orchestrator/README.md) |
| **YAML seul (sans Helm)** | revue de sécurité hors ligne | [`../infra/k8s/README.md`](../infra/k8s/README.md) |
| **Docker Compose** | site unique sans Kubernetes, démonstration durable | §8 |
| **Local (`pnpm dev`)** | développement, démo en 5 minutes | §9 |

## 2. Production — NKP + GitOps

Vue d'ensemble (détail pas-à-pas dans [`NKP.md`](NKP.md)) :

```
tag git vX.Y.Z
   │
   ├─► CI (.github/workflows/release.yml)
   │      images GHCR signées cosign + SBOM + scan trivy
   │      chart Helm OCI signé
   │      manifest.xml / manifest.json en assets de release
   │
   └─► GitRepository Flux (ref.semver) ─► Kustomization `oao-prod`
              │                                 (déchiffre les Secrets SOPS)
              └─► HelmRelease `oao`
                       values.yaml + values-nkp.yaml + envs/prod/values.yaml
                       │
                       ├─ Job de migration (hook pre-upgrade)
                       └─ rollout api / worker / admin / addin
```

Les cinq gestes de l'installation initiale :

```bash
# 1. Prérequis cluster (Traefik, cert-manager, kube-prometheus-stack, CSI)
#    et ClusterIssuer de la PKI interne                        -> NKP.md §2
# 2. Namespace + secret de pull GHCR                            -> NKP.md §4
# 3. Secrets applicatifs chiffrés (SOPS/age) ou ESO             -> NKP.md §4
# 4. Dépôt attaché dans Kommander (Applications -> Git repository) -> NKP.md §5
# 5. Overlay d'environnement (hosts, LLM, Entra ID, CIDR GPU)   -> NKP.md §6
```

Ce que l'opérateur doit obligatoirement renseigner (le chart refuse de rendre
une configuration cohérente sans) :

| Valeur | Où | Source |
|---|---|---|
| `hosts.api` / `hosts.admin` / `hosts.addin` | `envs/<env>/values.yaml` | §5 |
| `llm.baseUrl`, `llm.model`, `llm.egress.cidrs` | idem | §7 |
| `auth.aad.tenantId`, `auth.aad.clientId` | idem | §3.1 |
| `admin.entra.clientId` | idem | §3.3 |
| `graph.sync.groupId` (si `graph.enabled`) | idem | §4 |
| `AAD_CLIENT_SECRET`, `ADMIN_API_TOKEN`, `METRICS_TOKEN`, `POSTGRES_PASSWORD`, `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Secret SOPS / ESO | §3 |
| `ingress.tls.certManager.issuerRef`, `addin.tls.issuerRef` | `values-nkp.yaml` | §5 |

## 3. Entra ID (Azure AD) — les trois app registrations

Trois applications distinctes, une par frontière de confiance. Les séparer
permet de révoquer l'une sans casser les autres et de garder des scopes
minimaux.

```
Outlook (add-in, SPA)         ──SSO Office──►  API `access_as_user`
                                                    │
Dashboard admin (web, Auth.js) ──OIDC──────────►    │ (app roles)
                                                    │
                                     orchestrator ──OBO/app──► Microsoft Graph
```

### 3.1 App registration « API » (l'orchestrator)

1. **Entra ID → App registrations → New registration**
   - Nom : `Outlook AI Orchestrator — API`
   - Supported account types : **single tenant**.
2. Relever **Application (client) ID** → `auth.aad.clientId` et
   **Directory (tenant) ID** → `auth.aad.tenantId`.
3. **Expose an API** :
   - Application ID URI : `api://api.oao.northbridge.example` (ou
     `api://<client-id>`) ;
   - **Add a scope** : `access_as_user`, *Who can consent* = Admins and users,
     état **Enabled**.
   - **Add a client application** : ajouter le client ID de l'app add-in
     (§3.2) et cocher `access_as_user` — c'est ce qui rend le SSO Office
     silencieux (pas de popup de consentement).
   - **Add a client application** (deuxième entrée) : le client ID de l'app
     *Dashboard* (§3.3), également coché sur `access_as_user` — sans quoi le
     dashboard n'obtient jamais de jeton d'audience `api://…`.
4. **App roles** (recommandé, plutôt que `ADMIN_EMAILS`/`COMPLIANCE_EMAILS`) :
   créer **`Admin`** et **`Compliance`** — *Allowed member types* :
   **Users/Groups** *et* **Applications** si le dashboard doit les porter —
   puis les assigner à des groupes dans **Enterprise applications → Users and
   groups**. L'orchestrator et le dashboard dérivent tous deux le RBAC de la
   claim `roles` du jeton (comparaison insensible à la casse), avec
   `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` en repli
   ([`SECURITY.md`](SECURITY.md) §RBAC).
5. **Certificates & secrets → New client secret** : la valeur va dans
   `AAD_CLIENT_SECRET` (Secret SOPS/ESO — jamais dans un fichier versionné en
   clair). Noter la date d'expiration dans le calendrier d'exploitation
   ([`OPERATIONS.md`](OPERATIONS.md) §rotation).
6. Le client ID de cette app alimente **deux** valeurs : `auth.aad.clientId`
   (audience acceptée par l'API) et `admin.orchestratorApiClientId` du chart
   (scope demandé par le dashboard — vide = `auth.aad.clientId`, ce qui est le
   cas courant).

### 3.2 App registration « Add-in » (SPA, SSO Office)

1. **New registration** → `Outlook AI Orchestrator — Add-in`, single tenant.
2. **Authentication → Add a platform → Single-page application**, redirect
   URIs :
   - `https://addin.oao.northbridge.example/taskpane.html` (production)
   - `https://localhost:3000/taskpane.html` (développement)
3. **API permissions → My APIs** → *Outlook AI Orchestrator — API* →
   `access_as_user`.
4. **Expose an API** : Application ID URI
   `api://addin.oao.northbridge.example/<client-id>` et un scope
   `access_as_user` — Office exige que le `Resource` du `WebApplicationInfo`
   appartienne au domaine qui héberge le volet.
5. **Grant admin consent** pour le tenant.
6. Ce client ID alimente `AAD_CLIENT_ID` du rendu de manifest
   (`pnpm manifest:render`, build arg `AAD_CLIENT_ID` de l'image add-in), qui
   écrit le bloc :

   ```xml
   <WebApplicationInfo>
     <Id>{client ID de l'app Add-in}</Id>
     <Resource>api://addin.oao.northbridge.example/{client ID}</Resource>
     <Scopes><Scope>access_as_user</Scope></Scopes>
   </WebApplicationInfo>
   ```

### 3.3 App registration « Dashboard »

1. **New registration** → `Outlook AI Orchestrator — Dashboard`, single tenant.
2. **Authentication → Add a platform → Web**, redirect URI **exactement** :

   ```
   https://<hosts.admin>/api/auth/callback/microsoft-entra-id
   ```

   soit `https://admin.oao.northbridge.example/api/auth/callback/microsoft-entra-id`
   (convention Auth.js v5 : `/api/auth/callback/<provider id>`). Ajouter
   `http://localhost:3001/api/auth/callback/microsoft-entra-id` pour le
   développement si besoin.
3. **API permissions → My APIs** → *Outlook AI Orchestrator — API* →
   *Delegated* → `access_as_user`, puis **Grant admin consent**. C'est ce qui
   fait que la session du dashboard porte un **access token pour l'API**
   (audience `api://<client id API>`) et pas seulement un id token.
   Les scopes demandés à la connexion sont exactement
   `openid profile email offline_access api://<ORCHESTRATOR_API_CLIENT_ID>/access_as_user`
   (`apps/admin/src/lib/entra.ts`) ; `offline_access` est indispensable à la
   rotation du refresh token.
4. **Certificates & secrets → New client secret** →
   `AUTH_MICROSOFT_ENTRA_ID_SECRET`.
5. Générer la clé de signature de session : `openssl rand -base64 32` →
   `AUTH_SECRET`.
6. Restreindre l'accès : **Enterprise applications → Properties →
   Assignment required = Yes**, puis assigner uniquement les groupes
   `Admin`/`Compliance`.
7. Valeurs du chart : `admin.authMode: aad`, `admin.entra.clientId`,
   `admin.entra.tenantId` (par défaut celui de `auth.aad.tenantId`),
   `admin.entra.issuer` (par défaut
   `https://login.microsoftonline.com/<tenant>/v2.0`). Le chart rend
   `AUTH_URL=https://<hosts.admin>`, `AUTH_MICROSOFT_ENTRA_ID_*` et
   `ORCHESTRATOR_API_CLIENT_ID`. **Il n'existe pas** de variable
   `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` : Auth.js v5 identifie le tenant par
   l'issuer.

### 3.4 Où va chaque valeur

| Valeur Entra ID | Variable / value du chart |
|---|---|
| Directory (tenant) ID | `AAD_TENANT_ID` · `auth.aad.tenantId` (et `admin.entra.tenantId` par défaut) |
| App **API** — client ID | `AAD_CLIENT_ID` · `auth.aad.clientId` · `ORCHESTRATOR_API_CLIENT_ID` (dashboard) |
| App **API** — client secret | `AAD_CLIENT_SECRET` (Secret, `AAD_CLIENT_SECRET_FILE`) |
| App **API** — scope exposé | `AAD_REQUIRE_SCOPE=access_as_user` · `auth.aad.requireScope` |
| App **Add-in** — client ID | build arg `AAD_CLIENT_ID` de l'image add-in / `pnpm manifest:render` |
| App **Dashboard** — client ID | `AUTH_MICROSOFT_ENTRA_ID_ID` · `admin.entra.clientId` |
| App **Dashboard** — client secret | `AUTH_MICROSOFT_ENTRA_ID_SECRET` (Secret, `secrets.adminEntraClientSecret`) |
| Issuer | `AUTH_MICROSOFT_ENTRA_ID_ISSUER` · `admin.entra.issuer` |
| Groupes `Admin` / `Compliance` | app roles (claim `roles`), repli `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` |

## 4. Microsoft Graph et le worker de précalcul

Deux modes, indépendants :

| Mode | `graph.authMode` | Qui agit | Permissions |
|---|---|---|---|
| **Délégué (OBO)** | `obo` | l'utilisateur connecté, à la demande | déléguées : `Mail.Read` (phase 1), puis `Mail.ReadWrite`, `Tasks.ReadWrite`, `Calendars.ReadWrite`, `offline_access` |
| **Applicatif** | `app` | le worker, en tâche de fond (précalcul, daily brief) | applicatives : `Mail.Read`, `User.Read.All` (résolution du groupe) |

Déclaration côté Entra ID, sur l'app **API** (§3.1) :
**API permissions → Add a permission → Microsoft Graph → Application
permissions** → `Mail.Read` (+ `User.Read.All` pour résoudre les membres du
groupe `SYNC_GROUP_ID`) → **Grant admin consent for <tenant>**. Une permission
applicative n'est jamais consentie par l'utilisateur : sans ce consentement
explicite d'administrateur, le worker reçoit `403` sur chaque boîte.

Le mode applicatif donne par défaut accès à **toutes** les boîtes du tenant :
c'est inacceptable ici. Il faut le restreindre côté Exchange avec une
**application access policy** limitée à un groupe de sécurité mail-enabled.
Les deux étapes sont indissociables : la permission ouvre l'accès, la politique
le referme sur le périmètre autorisé.

```powershell
# Exchange Online PowerShell, une seule fois
Connect-ExchangeOnline

# 1. Le groupe qui délimite le périmètre (créé au préalable dans Entra ID,
#    type "mail-enabled security group")
$group = "oao-precompute@northbridge.example"

# 2. La politique : l'app ne peut lire QUE les boîtes membres du groupe
New-ApplicationAccessPolicy `
  -AppId "<client id de l'app API>" `
  -PolicyScopeGroupId $group `
  -AccessRight RestrictAccess `
  -Description "Outlook AI Orchestrator — precompute worker, scoped to the pilot group"

# 3. Vérifier, boîte par boîte
Test-ApplicationAccessPolicy -Identity utilisateur.pilote@northbridge.example -AppId "<client id>"
Test-ApplicationAccessPolicy -Identity hors.perimetre@northbridge.example  -AppId "<client id>"
# -> AccessCheckResult: Granted / Denied
```

Côté chart :

```yaml
graph:
  enabled: true
  authMode: app
  sync:
    groupId: "<object id du groupe oao-precompute>"   # ou sync.users: "upn1,upn2"
    intervalMinutes: 15
    maxMessagesPerRun: 200
features:
  precompute: true
  dailyBrief: true
  dailyBriefHour: 7        # heure locale, interprétée dans config.timezone
```

`GRAPH_AUTH_MODE=app` sans `SYNC_GROUP_ID` **ni** `SYNC_USERS` est refusé au
démarrage (`apps/orchestrator/src/config.ts`) : le worker ne doit jamais avoir
un périmètre implicite.

Ajouter un utilisateur au pilote = l'ajouter au groupe. Le retirer coupe
immédiatement l'accès Graph applicatif à sa boîte. Justification scope par
scope : [`SECURITY.md`](SECURITY.md) §permissions Graph.

## 5. DNS et certificats

### Noms DNS

| Nom | Cible | Sert |
|---|---|---|
| `api.oao.northbridge.example` | VIP Traefik | API orchestrator (`/api/v1/*`) |
| `admin.oao.northbridge.example` | VIP Traefik | dashboard de supervision |
| `addin.oao.northbridge.example` | VIP Traefik | bundle du volet + `/manifest/manifest.xml` |

Ces trois noms doivent être **résolvables depuis les postes clients** (Outlook
desktop) et depuis Microsoft 365 (Outlook on the web charge le volet dans un
iframe côté navigateur, donc côté poste également).

### Stratégie de certificats

1. **cert-manager + CA interne (recommandé, défaut du chart)** :
   `ClusterIssuer northbridge-internal-ca` ([`NKP.md`](NKP.md) §2), émission et
   renouvellement automatiques (`duration: 2160h`, `renewBefore: 360h`). La CA
   interne doit être distribuée aux postes Windows par GPO, sinon Outlook
   refuse de charger le volet.
2. **PKI d'entreprise (certificat émis à la main)** :
   `ingress.tls.certManager.enabled=false`, créer les Secrets TLS
   (`kubectl create secret tls oao-api-tls --cert=… --key=…`) et renseigner
   `ingress.tls.apiSecretName` / `adminSecretName` / `addin.tls.secretName`
   avec `addin.tls.mode: secret`. Le renouvellement redevient manuel : le
   noter dans le calendrier d'exploitation.
3. **Certificat public (Let's Encrypt via un ACME interne)** : possible si les
   noms sont résolvables publiquement ; même configuration que 1 avec un
   `ClusterIssuer` ACME.

Le pod add-in **termine TLS lui-même** (Office exige HTTPS sur l'hôte du
volet) : Traefik re-chiffre vers le backend. Avec un certificat interne,
activer `addin.traefik.serversTransport` et fournir la CA
(`rootCAsSecret`) pour que Traefik lui fasse confiance.

## 6. Déploiement centralisé du manifest (Microsoft 365)

Le manifest est un **artefact de version** : il est rendu au build avec les
hôtes de l'environnement et publié comme asset de release
(`manifest.xml`, `manifest.json`). Il est aussi servi par le pod add-in sur
`https://addin.oao.northbridge.example/manifest/manifest.xml`.

Rendu manuel si nécessaire :

```bash
ADDIN_HOST=https://addin.oao.northbridge.example \
API_HOST=https://api.oao.northbridge.example \
AAD_CLIENT_ID=<client id de l'app Add-in> \
ADDIN_VERSION=1.2.3.0 \
pnpm manifest:render
```

Déploiement à l'organisation :

1. **Microsoft 365 admin center → Settings → Integrated apps → Upload custom
   apps**.
2. Téléverser `manifest.xml` (ou l'URL `https://addin.…/manifest/manifest.xml`).
3. Choisir les utilisateurs/groupes cibles — **commencer par le groupe pilote**
   (le même que l'application access policy du §4).
4. Valider les permissions demandées : elles doivent correspondre aux scopes
   consentis au §3, et à rien de plus.
5. La propagation aux clients Outlook peut prendre jusqu'à 24 h.
6. Rollback : retirer l'attribution dans Integrated apps (le volet disparaît
   des clients), les données restent dans l'orchestrator.

## 7. Configuration de l'IA interne

L'orchestrator parle à n'importe quel serveur **compatible OpenAI**
(`/v1/chat/completions`, `/v1/embeddings`). Changer de modèle = changer des
valeurs `llm.*` (chart) ou `LLM_*` (`.env`), sans changement de code.

### vLLM (recommandé, Qwen3, 2 GPU)

```bash
vllm serve Qwen/Qwen3-30B-A3B-Instruct-AWQ \
  --served-model-name qwen3-30b-a3b \
  --quantization awq \
  --tensor-parallel-size 2 \
  --max-model-len 16384 \
  --host 0.0.0.0 --port 8000
```

Embeddings (`bge-m3`) via vLLM en mode `--task embed`, ou
**text-embeddings-inference** :

```bash
vllm serve BAAI/bge-m3 --task embed --served-model-name bge-m3 --host 0.0.0.0 --port 8001
# ou
docker run --gpus all -p 8001:80 \
  ghcr.io/huggingface/text-embeddings-inference:latest --model-id BAAI/bge-m3
```

> L'orchestrator suppose **un seul** `LLM_BASE_URL` pour le chat et les
> embeddings. Si ce sont deux serveurs distincts, les placer derrière un
> reverse-proxy interne unique qui route `/v1/chat/completions` vers l'un et
> `/v1/embeddings` vers l'autre.

### Ollama (dev/POC) et TGI

```bash
ollama pull qwen3 && ollama serve          # /v1 OpenAI-compatible sur :11434
```

Toutes les versions d'Ollama n'exposent pas `/v1/embeddings` pour tous les
modèles — préférer vLLM/TEI pour `bge-m3`. Pour TGI, vérifier
`LLM_JSON_MODE=prompt` si `response_format` n'est pas supporté.

### Azure OpenAI (tenant privé)

```bash
LLM_BASE_URL=https://<resource>.openai.azure.com/openai/deployments/<deployment>
LLM_API_KEY=<clé>
LLM_MODEL=<nom du déploiement>
```

### Valider la configuration

```bash
pnpm check:llm                # lit .env
pnpm check:llm ./autre.env
```

Le script teste `/models`, une complétion réelle, et `/embeddings` en
vérifiant que la dimension retournée correspond à `EMBEDDING_DIMENSIONS`
(sinon les migrations `vector(N)` sont incohérentes). Verdict OK/KO par étape,
code de sortie non nul en cas de problème bloquant.

En Kubernetes, le CIDR du nœud GPU doit figurer dans `llm.egress.cidrs` :
les NetworkPolicies sont en **default-deny**, un endpoint non déclaré est
silencieusement injoignable.

## 8. Déploiement Docker

Chemin de secours pour un site unique sans Kubernetes. Aucune HA, pas de HPA,
pas de NetworkPolicy, certificats à renouveler à la main.

```bash
cp .env.example .env
$EDITOR .env          # LLM_*, AAD_*, ADMIN_*, POSTGRES_PASSWORD, ADDIN_HOST…

export OAO_VERSION=0.1.0
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
pnpm smoke --url http://127.0.0.1:8080
```

Vérifier la signature des images **avant** le premier `up` :

```bash
cosign verify ghcr.io/northbridge-capital/oao-orchestrator:$OAO_VERSION \
  --certificate-identity-regexp '^https://github.com/northbridge-capital/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Particularités :

- `migrate` est un service one-shot : `orchestrator` attend sa complétion.
- `addin` exige un **vrai** certificat monté dans `${ADDIN_CERT_DIR}`
  (`addin.crt` + `addin.key`) : Outlook refuse l'auto-signé.
- `orchestrator` et `admin` n'écoutent que sur `127.0.0.1` par défaut
  (`ORCHESTRATOR_BIND`, `ADMIN_BIND`) : placer un reverse proxy TLS devant.
- Sauvegardes : `docker compose -f docker-compose.prod.yml --profile backup
  run --rm backup` (à planifier par cron/systemd-timer côté hôte).

Pour construire les images localement plutôt que de les tirer :
`docker compose up --build` (fichier `docker-compose.yml`), voir
[`../infra/docker/README.md`](../infra/docker/README.md).

## 9. Développement local

### Prérequis

| Outil | Version | Usage |
|---|---|---|
| Node.js | ≥ 20 | runtime des trois apps et de `scripts/*.mjs` |
| pnpm | 10.33.0 (via corepack) | monorepo |
| Docker Desktop / Engine | récent | PostgreSQL local (optionnel en mode démo) |
| Git | — | — |
| mkcert ou OpenSSL | optionnel | certificat HTTPS local si l'outillage Office échoue |
| helm | ≥ 3.12, optionnel | uniquement pour `pnpm k8s:render` |

Aucun besoin de bash, WSL, `curl` ou `make` : Windows PowerShell,
Command Prompt, Terminal macOS et n'importe quel shell Linux suffisent.

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

### Démo en 5 minutes (aucune dépendance externe)

```bash
git clone <repo-url> outlook-ai-agent
cd outlook-ai-agent
pnpm setup:dev        # .env, vérifications, install, build @oao/shared
pnpm certs            # certificat HTTPS local pour le volet
pnpm dev              # orchestrator :8080 · addin :3000 · admin :3001
pnpm smoke            # vérifie que tout répond
```

Le mode démo tourne avec `LLM_PROVIDER=mock`, `DATABASE_URL=memory`,
`AUTH_MODE=dev` (refusé si `NODE_ENV=production`).

**Un seul fichier `.env`, à la racine.** Les trois apps le lisent au démarrage
(orchestrator, `next.config.mjs` du dashboard, `vite.config.ts` de l'add-in) et
`pnpm check:llm` / `pnpm smoke` aussi. Priorité, de la plus forte à la plus
faible : variable déjà présente dans le shell ou le conteneur → `apps/<app>/.env`
(optionnel, pour surcharger localement) → `.env` racine. Après une modification
du `.env`, relancer `pnpm dev` : les valeurs sont lues une fois au démarrage.
L'orchestrator journalise les fichiers chargés (`envFiles`) et sa configuration
effective (secrets masqués) dans sa première ligne de log.

### Stack locale complète (PostgreSQL réel + modèle interne)

```bash
pnpm dev:db                      # PostgreSQL/pgvector, attend le healthcheck
# .env :
#   LLM_PROVIDER=openai-compatible
#   LLM_BASE_URL=http://gpu-node.northbridge.example:8000/v1
#   DATABASE_URL=postgres://oao:oao@localhost:5432/oao
pnpm check:llm
pnpm db:migrate && pnpm db:seed
pnpm dev
```

### Toutes les commandes de l'outillage

| Commande | Effet |
|---|---|
| `pnpm setup:dev` | bootstrap complet (`--no-db`, `--no-install`) |
| `pnpm dev:db [up\|down\|status\|logs\|reset\|psql]` | PostgreSQL local |
| `pnpm certs` | certificat HTTPS du volet (`--force`, `--mkcert`, `--openssl`) |
| `pnpm check:llm` | valide l'endpoint LLM interne |
| `pnpm smoke` | test de bout en bout (`--url`, `--token`, `--wait`) |
| `pnpm manifest:render` | rend les manifests Office depuis `ADDIN_HOST`/`API_HOST`/`AAD_CLIENT_ID` |
| `pnpm manifest:sideload` | charge le manifest dans Outlook (`--prod`, `--remove`, `--print`) |
| `pnpm --filter @oao/addin manifest:package[:dev]` | package d'app Teams (zip `manifest.json` + `color.png`/`outline.png`) pour l'entrée « Apps » du nouvel Outlook (§10.2) |
| `pnpm k8s:render` | régénère `infra/k8s/rendered/` depuis le chart Helm |
| `pnpm typecheck` / `lint` / `test` / `build` / `e2e` | qualité |

Toutes acceptent `--help`.

## 10. Sideload de l'add-in

### 10.1 Manifest XML — volet depuis un e-mail, volet épinglé, sélection multiple

```bash
pnpm manifest:sideload            # détecte l'OS et fait ce qu'il faut
pnpm manifest:sideload --print    # affiche seulement la procédure OWA
pnpm manifest:sideload --remove   # annule
```

| Plateforme | Ce que fait le script |
|---|---|
| **Windows, Outlook classique (Win32)** | enregistre le dossier du manifest sous `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` via PowerShell, puis redémarrer Outlook → *Accueil → Compléments → Mes compléments* |
| **macOS** | copie le manifest dans `~/Library/Containers/com.microsoft.Outlook/Data/Documents/wef`, puis redémarrer Outlook |
| **Linux / New Outlook / OWA** | affiche la procédure *Paramètres → Gérer les compléments → Mes compléments → Ajouter un complément personnalisé → Ajouter à partir d'un fichier* (ou *à partir d'une URL* vers `https://<ADDIN_HOST>/manifest/manifest.xml`) |

Prérequis commun : le serveur qui héberge le volet doit être joignable et son
certificat TLS reconnu (`pnpm certs` en local, CA interne déployée par GPO en
production). New Outlook pour Windows ne lit **pas** la clé de registre WEF :
utiliser la procédure web.

Ce seul manifest donne déjà **trois** façons d'ouvrir le volet :

1. depuis un e-mail ouvert → *AI Orchestrator → Ouvrir le panneau IA* ;
2. **volet épinglé** (icône 📌 dessinée par Outlook en haut du volet,
   `SupportsPinning`, Mailbox 1.5) : il reste ouvert pendant la navigation dans
   la liste, se recalcule à chaque message sélectionné (`ItemChanged`) et
   affiche l'accueil — résumé journalier + chat sur la boîte — quand **rien**
   n'est sélectionné (`SupportsNoItemContext`, Mailbox 1.8) ;
3. **plusieurs messages sélectionnés** (Ctrl/⌘ ou Maj + clic, `SupportsMultiSelect`,
   Mailbox 1.13) : vue *Sélection* → synthèse des N e-mails, chat limité à la
   sélection, actions proposées. Nécessite **le nouvel Outlook ou Outlook sur le
   web** ; sur Outlook classique le bouton reste simplement inactif sur une
   sélection multiple.

### 10.2 Manifest unifié (JSON) — entrée dans la barre « Apps » du nouvel Outlook

L'entrée dans la barre latérale **Apps** du nouvel Outlook / d'Outlook sur le web
(volet ouvert **sans aucun e-mail**, mode « home » : résumé journalier, chat sur
la boîte indexée, état de synchronisation, réglages) vient d'un **onglet
personnel** (`staticTabs`) déclaré dans le manifest unifié. Le manifest XML
classique **ne peut pas** l'exprimer.

Un manifest unifié ne se téléverse pas seul : il faut un **package d'app Teams**,
c'est-à-dire un zip contenant `manifest.json` à la racine plus les deux icônes
qu'il nomme (`color.png` 192×192, `outline.png` 32×32 monochrome).

```bash
# production (lit ADDIN_HOST/API_HOST/AAD_CLIENT_ID comme manifest:render)
pnpm manifest:render
pnpm --filter @oao/addin manifest:package        # → apps/addin/manifest/oao-addin-teams-app.zip

# développement (https://localhost:3000)
pnpm --filter @oao/addin manifest:package:dev    # → …/oao-addin-teams-app.dev.zip
```

Téléversement en tant qu'**app personnalisée** :

| Portée | Procédure |
|---|---|
| **Un utilisateur** (test, pilote) | Dans le nouvel Outlook ou dans Teams : *Apps → Gérer vos applications → Téléverser une application → Téléverser une application personnalisée* → choisir le zip. Nécessite la stratégie « autoriser le téléversement d'applications personnalisées » ; sinon l'entrée est grisée. |
| **Le tenant** | *Centre d'administration Teams → Applications Teams → Gérer les applications → Télécharger une nouvelle application*, puis publier et assigner l'app (stratégies d'autorisation/installation). |
| **Alternative M365** | *Microsoft 365 admin center → Paramètres → Applications intégrées → Téléverser des applications personnalisées* accepte aussi le package unifié ; c'est le même chemin que le §6 pour le XML. |

Ensuite, dans le nouvel Outlook / Outlook sur le web, l'app apparaît dans la
barre **Apps** à gauche ; un clic ouvre
`taskpane.html?view=home&host=tab`. Points d'attention :

* cet hôte n'a **pas** de `Office.context.mailbox` (et TeamsJS n'est
  volontairement pas chargé) : tous les appels Office.js du volet sont gardés,
  et le mode « home » n'a besoin d'aucun d'entre eux ;
* ce n'est **pas** le mode « preview » : le backend réel est appelé, aucune
  donnée d'exemple n'est affichée. Si l'orchestrator est injoignable, le volet
  affiche l'URL tentée, l'erreur et un bouton *Réessayer* (jamais l'e-mail
  d'exemple) ;
* Outlook classique (Windows/Mac) n'a pas de barre Apps : y utiliser le §10.1 ;
* ne pas déployer XML **et** JSON pour les mêmes utilisateurs dans le même
  tenant (deux fois le même complément).

## 11. Checklist de mise en production

> Version courte. La checklist de go-live complète, avec les preuves attendues
> et le plan de rollback, est [`PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md).

- [ ] Prérequis cluster validés ([`NKP.md`](NKP.md) §2) et `ClusterIssuer` `Ready`.
- [ ] Trois app registrations créées, admin consent donné, app roles assignés (§3).
- [ ] Exchange application access policy en place et testée
      (`Test-ApplicationAccessPolicy` → `Denied` hors du groupe) (§4).
- [ ] `AUTH_MODE=aad` / `auth.mode: aad` (le mode `dev` est refusé si
      `NODE_ENV=production`), `admin.authMode: aad`.
- [ ] Secrets uniquement dans SOPS ou un coffre (ESO) — `git grep` ne trouve
      aucune valeur sensible ; `features.demoSeed=false`.
- [ ] `llm.baseUrl` validé par `pnpm check:llm`, CIDR GPU déclaré dans
      `llm.egress.cidrs`, dimension d'embeddings cohérente avec les migrations.
- [ ] Migrations appliquées par le hook Helm (`kubectl -n oao get jobs` /
      schéma vérifié).
- [ ] `config.corsOrigins` restreint au domaine réel du volet.
- [ ] Certificats TLS réels sur les trois Ingress + CA interne distribuée aux
      postes.
- [ ] `config.auditStoreContent=false` sauf validation compliance explicite.
- [ ] `METRICS_TOKEN` renseigné ; `/metrics` renvoie `401` sans jeton.
- [ ] `CronJob` de sauvegarde actif **et restauration testée** sur un
      environnement isolé ([`OPERATIONS.md`](OPERATIONS.md) §sauvegardes).
- [ ] Alertes Prometheus reçues par l'astreinte (test d'une alerte volontaire).
- [ ] CI verte sur la révision déployée ; images signées vérifiées par cosign
      (ou politique Kyverno active — [`SECURITY.md`](SECURITY.md)).
- [ ] Manifest de production déployé via Integrated apps sur le groupe pilote (§6).
- [ ] Runbook [`OPERATIONS.md`](OPERATIONS.md) et matrice de gouvernance
      [`SECURITY.md`](SECURITY.md) relus par l'équipe compliance.

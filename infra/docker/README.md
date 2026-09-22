# Images de conteneurs

Trois images, construites depuis la **racine du dépôt** (le contexte de build
est le monorepo entier ; `.dockerignore` le réduit à ce qui est utile).

| Image | Dockerfile | Base runtime | Port | Utilisateur |
|---|---|---|---|---|
| `oao-orchestrator` | `orchestrator.Dockerfile` | `node:22-bookworm-slim` | 8080 | 1001 |
| `oao-admin` | `admin.Dockerfile` | `node:22-bookworm-slim` | 3001 | 1001 |
| `oao-addin` | `addin.Dockerfile` | `nginxinc/nginx-unprivileged:1.27-alpine` | 3000 (HTTPS) | 101 |

Publiées par `.github/workflows/release.yml` sur
`ghcr.io/<owner>/oao-{orchestrator,admin,addin}` avec SBOM (syft), scan
(trivy, échec sur CRITICAL) et signature **cosign keyless**.

## Propriétés communes

- **Gestionnaire de paquets** : `npm` uniquement — il est livré avec l'image
  `node:22`, donc aucune activation (Corepack ou autre) n'est nécessaire.
- **Multi-stage** : `base` → `deps` (`npm ci` filtré sur les workspaces utiles
  via `--workspace @oao/shared --workspace @oao/<app>`) → `build` → `runtime`.
  Le cache npm est monté en cache BuildKit
  (`--mount=type=cache,id=npm-cache,target=/root/.npm`) : il n'entre jamais
  dans une couche.
- **Lockfile gelé** : `npm ci` installe exactement ce que décrit
  `package-lock.json`. Un lockfile désynchronisé d'un `package.json` fait
  échouer le build — c'est voulu (reproductibilité).
- **Arbre de production propre** : l'orchestrator refait un
  `npm ci --omit=dev --workspace @oao/shared --workspace @oao/orchestrator`
  dans un répertoire vierge, de sorte qu'aucun outil de build n'atteint la
  couche runtime. Les liens de workspace créés par npm
  (`node_modules/@oao/* -> ../../…`) sont relatifs : l'image ne copie que
  `node_modules`, les `package.json`, les `dist/` et `migrations/`.
  Le dashboard, lui, s'appuie sur la sortie `standalone` de Next (elle embarque
  déjà son propre `node_modules` tracé, avec React 19 sous
  `apps/admin/node_modules`).
- **Non-root**, `USER <uid>:<gid>` numérique (exigé par
  `runAsNonRoot: true` côté Kubernetes, qui ne sait pas résoudre un nom).
- **Compatible `readOnlyRootFilesystem: true`** :

  | Image | Chemins écrits (emptyDir dans le chart) |
  |---|---|
  | orchestrator | `/tmp` |
  | admin | `/tmp`, `/app/apps/admin/.next/cache` |
  | addin | `/tmp`, `/var/cache/nginx`, `/etc/nginx/conf.d`, `/etc/nginx/certs` |

- **`HEALTHCHECK`** sans `curl` (aucun client HTTP supplémentaire installé) :
  `node -e "fetch(...)"` pour les images Node, `wget` busybox pour nginx.
- **Labels OCI** (`org.opencontainers.image.*`) dont `version`, `revision`,
  `created`, renseignés par la CI via `--build-arg`.
- **Secrets** : jamais de `ARG`/`ENV` secret. L'orchestrator lit
  `<NOM>_FILE` (fichier monté) ; voir `secrets.mountAsFiles` dans le chart.

## Builds locaux

```bash
docker build -f infra/docker/orchestrator.Dockerfile -t oao/orchestrator:dev .
docker build -f infra/docker/admin.Dockerfile        -t oao/admin:dev .
docker build -f infra/docker/addin.Dockerfile        -t oao/addin:dev \
  --build-arg ADDIN_HOST=addin.oao.northbridge.example \
  --build-arg API_HOST=api.oao.northbridge.example \
  --build-arg AAD_CLIENT_ID=<client id de l'app registration add-in> .
```

### Cas particulier de l'image add-in

Le bundle Vite **et** les manifests Office sont figés au build
(`VITE_API_BASE_URL`, `ADDIN_HOST`, `API_HOST`, `AAD_CLIENT_ID`) : un
manifest Office est un artefact de version, immuable, déployé ensuite par le
M365 admin center. Conséquence : **une image add-in par environnement**.

- `release.yml` construit l'image avec les hôtes de production
  (variables de dépôt `ADDIN_HOST`, `API_HOST`, `AAD_CLIENT_ID`).
- Pour un cluster de dev, reconstruire avec les hôtes de dev et pousser sous
  un tag distinct — ou laisser `addin.enabled=false` côté Helm et sideloader
  l'add-in depuis le serveur de dev local (`npm run dev`), ce que fait
  `infra/gitops/envs/dev`.

Les manifests rendus sont servis sur
`https://<ADDIN_HOST>/manifest/manifest.xml` (utile pour *Add from URL* et
pour Integrated Apps) et publiés comme assets de release par la CI.

## Certificat TLS de l'image add-in

`addin-entrypoint.sh` (exécuté par l'entrypoint de l'image nginx) :

1. certificat présent dans `/etc/nginx/certs` (`addin.crt` + `addin.key`) →
   ne fait rien. C'est le cas en production : le chart y monte le Secret
   cert-manager (`tls.crt`/`tls.key` renommés).
2. répertoire inscriptible et vide → génère un certificat auto-signé
   (dev/démo uniquement, Outlook le refusera).
3. répertoire non inscriptible et vide → échoue explicitement plutôt que de
   démarrer un service cassé.

## PostgreSQL

`postgres-init/01-extensions.sql` est monté dans
`/docker-entrypoint-initdb.d` par `docker-compose.yml` et crée l'extension
`vector` à la première initialisation du volume. Le chart Helm embarque
l'équivalent dans un ConfigMap (`infra/helm/.../templates/postgres.yaml`).

## Vérifications avant push

```bash
docker build -f infra/docker/orchestrator.Dockerfile -t oao/orchestrator:dev .
docker run --rm oao/orchestrator:dev node -e "console.log(process.getuid())"   # 1001
docker run --rm --read-only --tmpfs /tmp -e DATABASE_URL=memory -e LLM_PROVIDER=mock \
  -p 8080:8080 oao/orchestrator:dev                                            # démarre en rootfs read-only
trivy image --severity CRITICAL --exit-code 1 oao/orchestrator:dev
```

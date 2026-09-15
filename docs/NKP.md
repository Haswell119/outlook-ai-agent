# Déploiement sur Nutanix Kubernetes Platform (NKP)

> Procédure de bout en bout pour installer l'Outlook AI Orchestrator en
> production sur NKP, pour ~50 utilisateurs. Termes techniques en anglais.
> Voir aussi : [`SETUP.md`](SETUP.md) (Entra ID, DNS, manifests),
> [`OPERATIONS.md`](OPERATIONS.md) (exploitation), [`SECURITY.md`](SECURITY.md)
> (NetworkPolicy, secrets, signature d'images).

## Sommaire

1. [Ce qui est déployé](#1-ce-qui-est-déployé)
2. [Prérequis cluster](#2-prérequis-cluster)
3. [Prérequis hors cluster](#3-prérequis-hors-cluster)
4. [Préparer le namespace et les secrets](#4-préparer-le-namespace-et-les-secrets)
5. [Attacher le dépôt dans Kommander (Flux)](#5-attacher-le-dépôt-dans-kommander-flux)
6. [Première installation](#6-première-installation)
7. [Checklist de vérification](#7-checklist-de-vérification)
8. [Jour 2](#8-jour-2)
9. [Dépannage](#9-dépannage)

---

## 1. Ce qui est déployé

Un seul chart Helm — `infra/helm/outlook-ai-orchestrator` — produit :

| Objet | Rôle | Dimensionnement (50 utilisateurs) |
|---|---|---|
| Deployment `oao-api` | orchestrator `ROLE=api` | 2 répliques, 500m/1Gi, HPA 2→6 (CPU 70 %), PDB `minAvailable: 1` |
| Deployment `oao-worker` | orchestrator `ROLE=worker` (sync Graph, précalcul, daily brief, rétention) | 1 réplique, 500m/1Gi, `strategy: Recreate` |
| Deployment `oao-admin` | dashboard Next.js | 1 réplique, 250m/512Mi |
| Deployment `oao-addin` | nginx HTTPS servant le bundle + les manifests Office | 2 répliques, 50m/64Mi |
| StatefulSet `oao-postgres` | PostgreSQL 16 + pgvector | 1 réplique, 1 CPU/2Gi, PVC 20Gi `nutanix-volume` |
| Job `oao-migrate` | migrations SQL (hook `pre-install`/`pre-upgrade`) | one-shot |
| CronJob `oao-backup` | `pg_dump -Fc` quotidien (PVC ou Nutanix Objects) | 01:30 UTC |
| Ingress ×3 | `api.`, `admin.`, `addin.` via Traefik | TLS cert-manager |
| NetworkPolicy ×8 | default-deny + flux explicites | — |
| ServiceMonitor / PrometheusRule / ConfigMap Grafana | observabilité kube-prometheus-stack | — |

Total en régime nominal : ~4,3 CPU et ~7 Gi de `requests`, 20Gi de stockage
persistant (+50Gi pour les sauvegardes). Prévoir la marge HPA : ~7 CPU en
pointe.

## 2. Prérequis cluster

NKP ≥ 2.12, un workload cluster attaché à Kommander, avec :

| Composant | Fourni par | Vérification |
|---|---|---|
| **Traefik** (ingress) | Kommander (`traefik` dans `kommander`) | `kubectl get ingressclass` → `traefik` |
| **cert-manager** | Kommander (application `cert-manager`) | `kubectl get clusterissuer` |
| **kube-prometheus-stack** | Kommander (application `kube-prometheus-stack`) | `kubectl get servicemonitors -A \| head` |
| **Flux** | NKP par construction (`flux-system`) | `flux check` |
| **StorageClass** `nutanix-volume` (CSI) | Nutanix CSI provider | `kubectl get sc` |
| **metrics-server** | NKP | `kubectl top nodes` |
| **External Secrets Operator** (optionnel) | Kommander catalog | `kubectl get clustersecretstores` |

```bash
# Contrôle rapide de tous les prérequis
kubectl get ingressclass
kubectl get storageclass
kubectl -n kommander get deploy | grep -Ei 'traefik|prometheus|grafana'
kubectl get crd | grep -Ei 'certificates.cert-manager|servicemonitors|ingressroutes'
flux check
```

### ClusterIssuer cert-manager (PKI interne)

Le chart demande des certificats à un `ClusterIssuer` — aucun certificat n'est
stocké dans git. Avec la CA interne Northbridge :

```yaml
# 1. La CA (clé privée importée une fois, hors dépôt)
apiVersion: v1
kind: Secret
metadata:
  name: northbridge-internal-ca
  namespace: cert-manager
type: kubernetes.io/tls
stringData:
  tls.crt: |   # certificat de la CA interne
  tls.key: |   # clé privée de la CA interne
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: northbridge-internal-ca
spec:
  ca:
    secretName: northbridge-internal-ca
```

Variante recommandée si la PKI ne doit jamais quitter son HSM : un
`ClusterIssuer` de type ACME pointant vers le `step-ca`/ADCS interne, ou le
plugin `venafi`. Dans tous les cas, `kubectl get clusterissuer
northbridge-internal-ca` doit être `Ready=True` avant l'installation.

> Le certificat de la CA doit aussi être déployé dans le magasin de
> confiance des postes Windows (GPO) : Outlook refuse de charger un volet
> dont la chaîne TLS est inconnue.

## 3. Prérequis hors cluster

- **DNS** : `api.oao.northbridge.example`, `admin.oao.northbridge.example`,
  `addin.oao.northbridge.example` → VIP de l'ingress Traefik
  (`kubectl -n kommander get svc traefik -o wide`).
- **Entra ID** : trois app registrations (API, add-in, dashboard) et, pour le
  worker, les permissions applicatives Graph restreintes par une *Exchange
  application access policy* — procédure complète dans [`SETUP.md`](SETUP.md).
- **Endpoint LLM interne** joignable depuis le cluster (CIDR du/des nœuds GPU
  à déclarer dans `llm.egress.cidrs`, la NetworkPolicy étant en default-deny).
- **GHCR** : un PAT en lecture (`read:packages`) pour tirer les images.

## 4. Préparer le namespace et les secrets

```bash
kubectl create namespace oao
kubectl label namespace oao \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted

# Accès aux images GHCR
kubectl -n oao create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<compte-de-service-github> \
  --docker-password=<PAT read:packages>
```

Les secrets applicatifs ne sont **jamais** passés en ligne de commande en
production : ils vivent chiffrés dans git (SOPS/age) ou dans un coffre (ESO).
Voir [`../infra/gitops/README.md`](../infra/gitops/README.md) §3 et la liste
des clés attendues dans
[`../infra/gitops/envs/prod/secrets.example.yaml`](../infra/gitops/envs/prod/secrets.example.yaml).

```bash
age-keygen -o age.agekey                 # à conserver dans le coffre
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey

cp infra/gitops/envs/prod/secrets.example.yaml infra/gitops/envs/prod/secrets.enc.yaml
$EDITOR infra/gitops/envs/prod/secrets.enc.yaml
sops --encrypt --in-place infra/gitops/envs/prod/secrets.enc.yaml
# puis décommenter `- secrets.enc.yaml` dans infra/gitops/envs/prod/kustomization.yaml
```

## 5. Attacher le dépôt dans Kommander (Flux)

**Kommander → Applications → GitOps (Flux) → Git repository → Add repository**

| Champ | Valeur |
|---|---|
| Name | `oao-release` |
| URL | `https://github.com/northbridge-capital/outlook-ai-agent.git` |
| Ref | `semver: >=0.1.0` (suit les tags `vX.Y.Z`) |
| Credentials | PAT lecture seule, ou clé de déploiement SSH |
| Path | `./infra/gitops/envs/prod` |
| Prune | activé |

Équivalent CLI (ce que produit l'interface) :

```bash
kubectl -n flux-system create secret generic oao-git-auth \
  --from-literal=username=git --from-literal=password=<PAT>
kubectl apply -f infra/gitops/sources/
kubectl apply -f infra/gitops/clusters/nkp-prod/
```

## 6. Première installation

### Adapter l'overlay d'environnement

Éditer `infra/gitops/envs/prod/values.yaml` (aucun secret) :

```yaml
hosts: { api: api.oao.northbridge.example, admin: admin…, addin: addin… }
image: { tag: "0.1.0" }
llm:
  baseUrl: http://gpu-node.northbridge.example:8000/v1
  model: qwen3-30b-a3b
  egress: { cidrs: ["10.42.17.0/24"], ports: [8000] }
auth: { aad: { tenantId: "<tenant>", clientId: "<api client id>" } }
admin: { entra: { clientId: "<dashboard client id>" } }
graph: { enabled: true, authMode: app, sync: { groupId: "<groupe mail-enabled>" } }
postgres: { persistence: { size: 20Gi, storageClass: nutanix-volume } }
```

Commit + push : Flux réconcilie, applique le Job de migration puis déroule les
Deployments.

```bash
flux reconcile kustomization oao-prod --with-source
flux get helmreleases -n oao
kubectl -n oao get pods -w
```

### Variante sans GitOps (bootstrap ou cluster de test)

```bash
helm upgrade --install oao infra/helm/outlook-ai-orchestrator \
  -n oao --create-namespace \
  -f infra/helm/outlook-ai-orchestrator/values-nkp.yaml \
  -f infra/gitops/envs/prod/values.yaml \
  -f <(sops -d infra/gitops/envs/prod/secrets-values.enc.yaml)
```

`helm install` affiche en fin de sortie la liste des réglages obligatoires
encore manquants (`helm get notes oao -n oao`).

### Variante sans Helm

`pnpm k8s:render` régénère `infra/k8s/rendered/` depuis le chart — voir
[`../infra/k8s/README.md`](../infra/k8s/README.md) et ses limites (migrations
et rollback manuels).

## 7. Checklist de vérification

```bash
# Rollouts
kubectl -n oao rollout status deploy/oao-api --timeout=300s
kubectl -n oao rollout status deploy/oao-worker --timeout=300s
kubectl -n oao rollout status deploy/oao-admin --timeout=300s
kubectl -n oao rollout status deploy/oao-addin --timeout=300s
kubectl -n oao get statefulset oao-postgres

# Migrations (le Job est supprimé en cas de succès : vérifier le schéma)
kubectl -n oao exec statefulset/oao-postgres -- \
  psql -U oao -d oao -c '\dt' | head -20

# Certificats
kubectl -n oao get certificate
kubectl -n oao get secret oao-api-tls oao-admin-tls oao-addin-tls

# Réseau
kubectl -n oao get ingress
kubectl -n oao get networkpolicy
curl -sS https://api.oao.northbridge.example/api/v1/live
curl -sS https://api.oao.northbridge.example/api/v1/ready
curl -skI https://addin.oao.northbridge.example/taskpane.html | head -5
curl -sS https://addin.oao.northbridge.example/manifest/manifest.xml | head -5

# Bout en bout (depuis un poste ayant un jeton Entra ID)
pnpm smoke --url https://api.oao.northbridge.example --token "$JWT" --wait 60

# Observabilité
kubectl -n oao get servicemonitor,prometheusrule
kubectl -n kommander exec deploy/kube-prometheus-stack-operator -- true   # opérateur vivant
# Dans Grafana : dashboard "Outlook AI Orchestrator" (uid oao-overview)
```

Checklist fonctionnelle :

- [ ] `/api/v1/live` et `/api/v1/ready` répondent `200` à travers l'Ingress.
- [ ] `/api/v1/health` renvoie `status: ok` (et non `degraded`).
- [ ] `/metrics` renvoie `401` **sans** jeton et `200` avec `METRICS_TOKEN`.
- [ ] Les cibles `oao-api` et `oao-worker` sont `UP` dans Prometheus.
- [ ] Le dashboard Grafana affiche du trafic après une première requête.
- [ ] Un `pod exec` depuis un pod hors namespace vers `oao-postgres:5432`
      échoue (default-deny fonctionnel).
- [ ] Le volet s'ouvre dans Outlook après déploiement du manifest via le M365
      admin center ([`SETUP.md`](SETUP.md) §Integrated apps).
- [ ] Une action à risque `medium`/`high` demande bien une validation humaine,
      et l'événement apparaît dans l'audit du dashboard.
- [ ] `CronJob oao-backup` a produit un dump (`kubectl -n oao get jobs`).

## 8. Jour 2

| Sujet | Commande / renvoi |
|---|---|
| Mise à jour applicative | tag git `vX.Y.Z` → bump `image.tag` (PR) → Flux ([`OPERATIONS.md`](OPERATIONS.md) §upgrades) |
| Scaling | `orchestrator.api.autoscaling.maxReplicas`, ou requests/limits |
| Rollback | `flux suspend hr oao -n oao` + `helm rollback oao -n oao` |
| Sauvegarde / restauration | [`OPERATIONS.md`](OPERATIONS.md) §sauvegardes |
| Rotation de secret | éditer le fichier SOPS → commit → `rollout restart` |
| Rotation de certificat | automatique (cert-manager, `renewBefore: 360h`) |
| Catalogue d'alertes | [`OPERATIONS.md`](OPERATIONS.md) §alertes |
| Capacité | [`OPERATIONS.md`](OPERATIONS.md) §capacité |

## 9. Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| Pods `ImagePullBackOff` | secret `ghcr-pull` absent ou PAT sans `read:packages` | recréer le secret, vérifier `image.pullSecrets` |
| Pods en `CreateContainerConfigError` | clé manquante dans `oao-secrets` (souvent `POSTGRES_PASSWORD` ou `DATABASE_URL`) | `kubectl -n oao describe pod`, compléter le Secret SOPS/ESO |
| `oao-migrate` échoue | PostgreSQL pas prêt, `DATABASE_URL` faux, extension `vector` absente | `kubectl -n oao logs job/oao-migrate` (le Job est conservé en cas d'échec) |
| HelmRelease bloqué en `pending-upgrade` | hook de migration interrompu | `flux suspend hr oao -n oao`, `helm rollback`, corriger, `flux resume` |
| `/api/v1/ready` en `503` | LLM ou base injoignable → NetworkPolicy | vérifier `llm.egress.cidrs`, `pnpm check:llm` depuis un pod du namespace |
| Certificat `Ready=False` | ClusterIssuer absent ou CA non autorisée | `kubectl describe certificate -n oao`, `kubectl get clusterissuer` |
| Outlook refuse le volet | chaîne TLS inconnue du poste, ou CSP | déployer la CA interne par GPO ; vérifier l'absence de `X-Frame-Options` et la présence de `frame-ancestors` |
| Traefik renvoie `502` sur l'add-in | backend HTTPS non reconnu | annotation `serversscheme: https` sur le Service + `addin.traefik.serversTransport.enabled=true` avec la CA |
| Aucune cible dans Prometheus | labels du ServiceMonitor non sélectionnés | aligner `metrics.serviceMonitor.labels` sur le `serviceMonitorSelector` du Prometheus de Kommander |
| `/metrics` renvoie `200` sans jeton | `METRICS_TOKEN` vide | renseigner le secret, `rollout restart` |
| Volume PVC `Pending` | mauvaise StorageClass | `kubectl get sc`, ajuster `postgres.persistence.storageClass` |

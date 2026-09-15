# GitOps — Flux sur NKP (Kommander)

Nutanix Kubernetes Platform embarque **Flux** : NKP est piloté en GitOps par
construction. Ce répertoire contient tout ce que Flux doit lire pour
installer et maintenir l'Outlook AI Orchestrator, sans qu'aucun opérateur
n'exécute `helm` ni `kubectl apply` à la main.

```
infra/gitops/
├── sources/                  GitRepository (main / tags) + HelmRepository OCI
├── clusters/nkp-dev|nkp-prod Kustomization Flux (point d'entrée par cluster)
├── envs/dev|prod             namespace + HelmRelease + overlay de values + secrets SOPS
├── image-automation/         (optionnel) bump automatique des tags d'image
├── external-secrets/         alternative à SOPS (ESO)
└── .sops.yaml                règles de chiffrement age
```

## Chaîne complète

```
git tag v1.2.3
      │
      ▼  .github/workflows/release.yml
  images GHCR (ghcr.io/<owner>/oao-{orchestrator,admin,addin}:1.2.3, signées cosign)
  chart OCI (ghcr.io/<owner>/charts/outlook-ai-orchestrator:1.2.3)
      │
      ▼  GitRepository `oao-release` (ref.semver) — ou bump du tag par PR
  Flux Kustomization `oao-prod`  → envs/prod (SOPS déchiffré)
      │
      ▼
  HelmRelease `oao` → chart infra/helm/outlook-ai-orchestrator
      │                values.yaml + values-nkp.yaml + ConfigMap oao-values
      ▼
  Job de migration (hook pre-upgrade) puis rollout API / worker / admin / addin
```

## 1. Prérequis cluster

- NKP ≥ 2.12 avec Kommander, Flux (`flux-system`), Traefik, cert-manager et
  kube-prometheus-stack activés — détail : [`../../docs/NKP.md`](../../docs/NKP.md).
- StorageClass `nutanix-volume` (ou équivalent) disponible.
- Un `ClusterIssuer` cert-manager adossé à la PKI interne
  (`northbridge-internal-ca`).

## 2. Attacher le dépôt dans Kommander

Interface Kommander : **Applications → GitOps (Flux) → Git repository →
Add repository**

| Champ | Valeur |
|---|---|
| Name | `oao` |
| URL | `https://github.com/northbridge-capital/outlook-ai-agent.git` |
| Branch / Tag | `main` (dev) · `semver: >=0.1.0` (prod) |
| Credentials | PAT en lecture seule, ou clé de déploiement SSH |
| Path | `./infra/gitops/envs/prod` |

Équivalent CLI (identique à ce que produit l'interface) :

```bash
kubectl -n flux-system create secret generic oao-git-auth \
  --from-literal=username=git --from-literal=password=<PAT-lecture-seule>

kubectl apply -f infra/gitops/sources/
kubectl apply -f infra/gitops/clusters/nkp-prod/
```

## 3. Secrets (SOPS + age)

Aucun secret en clair n'entre dans le dépôt. Le `HelmRelease` référence le
Secret `oao-secrets` (`secrets.existingSecret`), fourni chiffré :

```bash
age-keygen -o age.agekey                    # conservé hors dépôt (coffre)
kubectl -n flux-system create secret generic sops-age --from-file=age.agekey

cp infra/gitops/envs/prod/secrets.example.yaml infra/gitops/envs/prod/secrets.enc.yaml
$EDITOR infra/gitops/envs/prod/secrets.enc.yaml
sops --encrypt --in-place infra/gitops/envs/prod/secrets.enc.yaml
# décommenter `- secrets.enc.yaml` dans envs/prod/kustomization.yaml
```

La `Kustomization` Flux porte `decryption.provider: sops` : le déchiffrement
a lieu dans le cluster, jamais sur un poste. Rotation d'un secret = éditer
(`sops fichier.enc.yaml`), commit, Flux reconcilie, puis
`kubectl -n oao rollout restart deploy/oao-api deploy/oao-worker`.

Alternative sans secret versionné : [External Secrets Operator](external-secrets/README.md).

## 4. Cycle de vie

| Opération | Geste |
|---|---|
| Déployer une version | `git tag vX.Y.Z && git push --tags` (prod suit `ref.semver`) |
| Changer un réglage | éditer `envs/<env>/values.yaml`, commit → Flux reconcilie |
| Forcer une reconciliation | `flux reconcile kustomization oao-prod --with-source` |
| Voir l'état | `flux get kustomizations`, `flux get helmreleases -n oao` |
| Rollback | `flux suspend hr oao -n oao && helm rollback oao -n oao` puis corriger le tag en git et `flux resume hr oao -n oao` |
| Suspendre les déploiements | `flux suspend kustomization oao-prod` |

`spec.upgrade.remediation.strategy: rollback` fait déjà revenir Flux à la
révision précédente si un upgrade échoue (2 tentatives), et
`driftDetection.mode: enabled` ré-applique toute modification faite à la main
dans le cluster — le dépôt git reste la source de vérité.

## 5. Mise à jour des tags d'image

Deux modes, au choix :

1. **Par PR (défaut)** — `release.yml` publie les images, un humain met à
   jour `image.tag` dans `envs/prod/values.yaml` via une PR. Traçable,
   revu, compatible avec une politique de changement stricte.
2. **Flux image automation (optionnel)** — appliquer `image-automation/` :
   Flux réécrit le champ marqué
   `# {"$imagepolicy": "flux-system:oao:tag"}` et pousse sur la branche
   `flux-image-updates` (jamais directement sur `main`), ce qui laisse la PR
   comme point de contrôle.

## 6. Différences dev / prod

| | dev (`envs/dev`) | prod (`envs/prod`) |
|---|---|---|
| Namespace | `oao-dev` | `oao` |
| Source | `GitRepository oao` (branche `main`) | `GitRepository oao-release` (tags semver) |
| LLM | `provider: mock` | endpoint interne vLLM |
| Graph / worker | désactivé | activé (précalcul + daily brief) |
| API | 1 réplica, pas d'HPA | 2→6 répliques, HPA + PDB |
| Sauvegardes | désactivées | CronJob quotidien |
| Dashboard | `admin.authMode: token` | `admin.authMode: aad` |

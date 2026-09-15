# `infra/k8s` — déploiement sans Helm

**Le chart Helm `infra/helm/outlook-ai-orchestrator` est la source unique de
vérité du déploiement.** Ce répertoire ne contient plus de manifests écrits à
la main (ils divergeaient du chart) : `rendered/` est la **sortie générée**
de `helm template`, pour les environnements qui n'appliquent que du YAML.

```bash
pnpm k8s:render                       # values-nkp.yaml, namespace oao
pnpm k8s:render --env dev             # + infra/gitops/envs/dev/values.yaml
pnpm k8s:render --namespace oao-test --release oao-test
```

Le script (`scripts/render-k8s.mjs`) force `secrets.create=false` et
`secrets.existingSecret=oao-secrets` : **aucun secret ne peut atterrir dans
le dépôt**.

## Application

```bash
kubectl create namespace oao

# 1. Le Secret attendu (jamais versionné en clair) :
#    voir infra/gitops/envs/prod/secrets.example.yaml pour la liste des clés
kubectl -n oao apply -f mon-secret-oao.yaml

# 2. Les migrations : c'est un hook Helm, donc à appliquer explicitement ici
kubectl -n oao apply -f rendered/outlook-ai-orchestrator/templates/job-migrate.yaml
kubectl -n oao wait --for=condition=complete job/oao-migrate --timeout=600s

# 3. Le reste
kubectl -n oao apply -R -f rendered/outlook-ai-orchestrator/templates
kubectl -n oao rollout status deploy/oao-api
```

## Limites de ce chemin

| Fonction | Avec Helm/Flux | Avec `rendered/` |
|---|---|---|
| Migrations avant rollout | hook `pre-upgrade` automatique | `kubectl apply` du Job, à la main, avant le reste |
| Rollback | `helm rollback` / remédiation Flux | `kubectl apply` de la version précédente |
| Détection de dérive | `driftDetection` Flux | aucune |
| Secrets | SOPS ou External Secrets | Secret créé hors flux, à la main |

Autrement dit : utilisable pour un cluster de test ou une revue de sécurité
hors ligne, mais la production NKP passe par
[`../gitops/`](../gitops/README.md).

> Les fichiers sous `rendered/` sont régénérés : toute modification manuelle
> sera écrasée au prochain `pnpm k8s:render`. Corriger le chart, pas la
> sortie. Voir aussi `.gitattributes` (`linguist-generated`).

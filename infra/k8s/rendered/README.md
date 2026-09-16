# Manifests générés — NE PAS ÉDITER

Sortie de `helm template` pour le chart
`infra/helm/outlook-ai-orchestrator` (source unique de vérité).

- Régénérer : `pnpm k8s:render` (options : `--env dev|prod`, `--namespace`)
- Namespace : `oao` · release : `oao`
- Values appliquées : `infra/helm/outlook-ai-orchestrator/values-nkp.yaml`
- Secrets : **non rendus**. Ces manifests attendent un Secret existant
  nommé `oao-secrets` (voir `infra/gitops/envs/*/secrets.example.yaml`).

Application :

```bash
kubectl create namespace oao
kubectl -n oao apply -f <votre secret oao-secrets>
kubectl -n oao apply -R -f infra/k8s/rendered/outlook-ai-orchestrator/templates
```

Le Job de migration est un hook Helm : sans Helm, l'appliquer explicitement
avant le reste (`job-migrate.yaml`), ou utiliser `DB_AUTO_MIGRATE=true`.

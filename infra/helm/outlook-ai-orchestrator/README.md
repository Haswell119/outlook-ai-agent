# Chart Helm — `outlook-ai-orchestrator`

Packaging de production de l'Outlook AI Orchestrator : add-in (nginx/TLS),
orchestrator `ROLE=api` (HPA/PDB), orchestrator `ROLE=worker`, dashboard
admin, PostgreSQL/pgvector optionnel, NetworkPolicies, ServiceMonitor,
PrometheusRule, dashboard Grafana, Job de migration, CronJob de sauvegarde.

Cible principale : **Nutanix Kubernetes Platform (NKP)** — Traefik comme
ingress, `nutanix-volume` comme storage class, `kube-prometheus-stack` et
`cert-manager` fournis par Kommander. Le chart reste utilisable sur
n'importe quel cluster conforme (`ingress.className`, `storageClass`,
sélecteurs de namespace configurables).

## Installation

```bash
# 1. Valider le rendu
helm lint infra/helm/outlook-ai-orchestrator
helm template oao infra/helm/outlook-ai-orchestrator -n oao \
  -f infra/helm/outlook-ai-orchestrator/values-nkp.yaml | kubeconform -strict -summary -

# 2. Installer / mettre à jour
helm upgrade --install oao infra/helm/outlook-ai-orchestrator \
  -n oao --create-namespace \
  -f infra/helm/outlook-ai-orchestrator/values-nkp.yaml \
  -f secrets.yaml            # fichier chiffré SOPS déchiffré à la volée, ou ESO

# 3. Vérifier
kubectl -n oao rollout status deploy/oao-api
kubectl -n oao get pods,ingress,networkpolicy
```

En production, on n'appelle pas `helm` à la main : Flux applique le
`HelmRelease` de `infra/gitops/envs/<env>/` (voir `infra/gitops/README.md`).

Chart OCI publié par la CI sur chaque tag :
`oci://ghcr.io/northbridge-capital/charts/outlook-ai-orchestrator`.

## Valeurs que l'opérateur DOIT renseigner

| Valeur | Rôle |
|---|---|
| `hosts.api` / `hosts.admin` / `hosts.addin` | noms DNS publics (doivent résoudre vers la VIP Traefik) |
| `llm.baseUrl` / `llm.model` | endpoint OpenAI-compatible interne (vLLM…) et `--served-model-name` → `LLM_BASE_URL`, `LLM_MODEL` |
| `llm.fastModel` | petit modèle pour triage-assist, classification, phishing, extraction → `LLM_FAST_MODEL`. Vide = tout sur `llm.model`, charge GPU quasi doublée |
| `llm.embeddings.model` / `llm.embeddings.dimensions` | `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` — la dimension **doit** égaler la colonne `vector(N)` des migrations |
| `secrets.llmApiKey` | `LLM_API_KEY` si l'endpoint interne en exige une (souvent vide en interne) |
| `llm.egress.cidrs` / `llm.egress.ports` | CIDR du/des nœuds GPU (NetworkPolicy — pas de résolution DNS possible) |
| `auth.aad.tenantId` / `auth.aad.clientId` | App registration de l'API (`access_as_user`) |
| `admin.entra.clientId` | App registration du dashboard (Auth.js) |
| `admin.orchestratorApiClientId` | client id de l'app **API**, pour le scope `api://…/access_as_user` demandé par le dashboard. Vide = `auth.aad.clientId` (cas courant) ; sans l'un ni `admin.apiScope`, le dashboard refuse de démarrer en `authMode: aad` |
| `secrets.aadClientSecret` | secret client pour l'échange On-Behalf-Of vers Graph |
| `secrets.adminApiToken` | jeton partagé dashboard → API |
| `secrets.metricsToken` | bearer token de `/metrics` (utilisé par le ServiceMonitor) |
| `secrets.adminEntraClientSecret`, `secrets.adminAuthSecret` | authentification du dashboard |
| `secrets.postgresPassword` | mot de passe PostgreSQL (si `postgres.enabled=true`) |
| `postgres.external.*` ou `secrets.databaseUrl` | si `postgres.enabled=false` |
| `ingress.tls.certManager.issuerRef` / `addin.tls.issuerRef` | ClusterIssuer de la PKI interne |
| `image.pullSecrets` | secret d'accès à GHCR |

`helm install` affiche (NOTES.txt) la liste des réglages obligatoires encore
manquants — la sortie est aussi visible via `helm get notes oao -n oao`.

## Stratégies de secrets (mutuellement exclusives)

1. **`secrets.create=true`** (défaut) — le chart rend le Secret à partir des
   values. Acceptable uniquement si les values viennent d'un fichier chiffré
   (SOPS/age, voir `infra/gitops/.sops.yaml`).
2. **`secrets.existingSecret: <nom>`** — Secret géré hors du chart (kubectl,
   Sealed Secrets, ESO…). Clés attendues : `secrets.existingSecretKeys`.
3. **`externalSecrets.enabled=true`** — le chart rend un `ExternalSecret`
   (External Secrets Operator) qui matérialise `<fullname>-secrets`.

> Chaque clé listée dans `secrets.existingSecretKeys` (option 2) doit exister
> réellement : le chart en dérive un `<NOM>_FILE`, et un fichier absent fait
> échouer le démarrage (fail closed). `POSTGRES_PASSWORD` y figure car le
> StatefulSet PostgreSQL le lit quand `postgres.enabled=true`.

> ⚠ Avec l'option 3, le Secret n'existe pas encore au moment du hook
> `pre-install` : pour la **première** installation, soit pré-créer
> l'`ExternalSecret`, soit utiliser `migration.enabled=false` +
> `migration.autoAtBoot=true` (l'orchestrator applique les migrations au
> démarrage), puis revenir au Job de migration.

Par défaut (`secrets.mountAsFiles=true`) les secrets sont **montés en
fichiers** sous `/run/secrets/oao/` et l'orchestrator lit `<NOM>_FILE` : rien
n'apparaît dans l'environnement du pod ni dans `kubectl describe pod`.

## Rôles orchestrator

| Objet | `ROLE` | Réplicas | Contenu |
|---|---|---|---|
| Deployment `-api` + Service + HPA + PDB | `api` (+ `WORKERS_ENABLED=false`) | 2 → 6 (HPA CPU/RPS) | API HTTP `/api/v1/*`, `/metrics` |
| Deployment `-worker` + Service | `orchestrator.worker.role`, défaut **`all`** (+ `WORKERS_ENABLED=true`) | 1 (`strategy: Recreate`) | mailbox sync, précalcul, daily brief, rétention. Élection de leader par advisory lock PostgreSQL |

Le Service du worker n'est pas routé par l'ingress : il n'existe que pour les
probes et le scrape Prometheus (`oao_mailbox_sync_lag_seconds`, profondeur de
file), qui ne remontent que de ce rôle.

> **Pourquoi `role: all` sur le pod worker ?** `servesApi()`
> (`apps/orchestrator/src/config.ts`) n'est vrai que pour `api` et `all` :
> avec `ROLE=worker` le processus **n'ouvre aucun port**, donc les probes HTTP
> échoueraient et `/metrics` serait injoignable. `role: all` conserve
> l'ordonnanceur *et* un listener local ; l'API n'est exposée ni par l'Ingress
> ni par une NetworkPolicy d'entrée autre que monitoring/kubelet.
> `orchestrator.worker.role=worker` reste supporté : le chart supprime alors
> les probes, le Service et l'endpoint du ServiceMonitor pour ce pod (et
> l'alerte `OaoWorkerAbsent` ne peut plus se déclencher).

## Migrations

Job Helm `pre-install,pre-upgrade` (`migration.enabled=true`) :
`node apps/orchestrator/dist/adapters/db/migrate.js`. Comme les hooks
s'exécutent avant les objets de la release, le Job dispose de copies
hook-scoped du ConfigMap et du Secret (poids `-10`, supprimées au succès).
En cas d'échec, le Job et ses copies sont conservés pour diagnostic :

```bash
kubectl -n oao logs job/oao-migrate
```

## Ingress / TLS

- `ingress.className` (défaut `traefik`) : les annotations nginx
  (`proxy-body-size`, timeouts, `backend-protocol`) ne sont émises que si la
  classe contient `nginx` ; en Traefik le chart émet
  `router.entrypoints`/`router.tls` et un `Middleware` `buffering` pour la
  limite de corps.
- Le pod add-in **termine TLS lui-même** (Office exige HTTPS sur l'hôte du
  volet) : la Service porte `traefik…/service.serversscheme: https`
  (ou `backend-protocol: HTTPS` en nginx). Avec un certificat interne,
  activer `addin.traefik.serversTransport` pour que Traefik fasse confiance
  à la CA Northbridge.
- `traefik.ingressRoute.enabled=true` fournit la variante `IngressRoute`
  native (mettre alors `ingress.enabled=false`).

## Observabilité

- `ServiceMonitor` : scrape `/metrics` sur les Services `-api` et `-worker`,
  avec `bearerTokenSecret` → clé `METRICS_TOKEN`.
- `PrometheusRule` : `OaoApiDown`, `OaoReadinessFailing`,
  `OaoLlmCircuitOpen`, `OaoLlmErrorRateHigh`, `OaoHttp5xxRateHigh`,
  `OaoLatencyHigh`, `OaoMailboxSyncLag`, `OaoWorkerAbsent`,
  `OaoDatabaseUnreachable` (seuils dans
  `metrics.prometheusRule.thresholds`).
- Dashboard Grafana : ConfigMap labellisé `grafana_dashboard: "1"`
  (`dashboards/outlook-ai-orchestrator.json`).

Métriques consommées par le `PrometheusRule` et le dashboard — toutes exposées
par `apps/orchestrator/src/metrics.ts` :
`oao_http_requests_total{method,route,status}`,
`oao_http_request_duration_seconds{method,route,status}`,
`oao_llm_calls_total{model,use_case,outcome,priority}`,
`oao_llm_call_duration_seconds{model,use_case}`, `oao_llm_circuit_open`,
`oao_llm_queue_depth{lane}`, `oao_llm_queue_running`,
`oao_cache_hits_total{cache}`, `oao_cache_misses_total{cache}`,
`oao_mailbox_sync_lag_seconds{user}`,
`oao_mailbox_sync_runs_total{outcome,mode}`, `oao_audit_events_total{type}`,
`oao_db_up`, `oao_build_info{version,role}`.

Le catalogue complet (files, tokens, triage, appels évités, briefs) est dans
`docs/OPERATIONS.md` §3.

## Sauvegardes

`postgres.backup.enabled=true` → CronJob `pg_dump -Fc` quotidien vers un PVC
(`destination: pvc`) ou un bucket S3-compatible / Nutanix Objects
(`destination: s3`, credentials dans `postgres.backup.s3.existingSecret`).
Restauration et RPO/RTO : `docs/OPERATIONS.md`.

## Alternative sans Helm

`infra/k8s/rendered/` contient la sortie de `helm template` (générée par
`npm run k8s:render`) pour les environnements qui n'appliquent que du YAML.
C'est un artefact **généré** : ne pas l'éditer à la main.

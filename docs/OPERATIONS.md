# Runbook opérationnel — Outlook AI Orchestrator

> Pour les équipes qui exploitent le service en production (SRE / IT
> Northbridge). Aligné sur le chart Helm `infra/helm/outlook-ai-orchestrator`
> et le déploiement GitOps `infra/gitops`. Termes techniques en anglais.
>
> Installation : [`NKP.md`](NKP.md) · Configuration : [`SETUP.md`](SETUP.md) ·
> Sécurité : [`SECURITY.md`](SECURITY.md)

## Sommaire

1. [Carte du système](#1-carte-du-système)
2. [Santé et probes](#2-santé-et-probes)
3. [Métriques](#3-métriques)
4. [Catalogue d'alertes](#4-catalogue-dalertes)
5. [Logs et requêtes utiles](#5-logs-et-requêtes-utiles)
6. [Mises à jour, rollback, migrations](#6-mises-à-jour-rollback-migrations)
7. [Scaling et capacité (50 utilisateurs)](#7-scaling-et-capacité-50-utilisateurs)
8. [Secrets et rotation](#8-secrets-et-rotation)
9. [Sauvegardes et restauration](#9-sauvegardes-et-restauration)
10. [DR — RPO / RTO](#10-dr--rpo--rto)
11. [Panne du modèle IA](#11-panne-du-modèle-ia)
12. [Worker de synchronisation](#12-worker-de-synchronisation)
13. [Rétention et purge de l'audit](#13-rétention-et-purge-de-laudit)
14. [Incidents fréquents](#14-incidents-fréquents)
15. [Dimension des embeddings (pgvector)](#15-dimension-des-embeddings-pgvector)
16. [Moteur de décision Laya (optionnel)](#16-moteur-de-décision-laya-optionnel)

---

## 1. Carte du système

| Composant | Objet Kubernetes | Rôle | Sans lui |
|---|---|---|---|
| API | `deploy/oao-api` (`ROLE=api`) | `/api/v1/*`, `/metrics` | le volet Outlook et le dashboard sont hors service |
| Worker | `deploy/oao-worker` (`ROLE=all` + `WORKERS_ENABLED=true`, hors Ingress) | sync Graph, précalcul, daily brief, rétention | pas de précalcul ni de brief, l'audit n'est plus purgé |
| Dashboard | `deploy/oao-admin` | supervision, approbations compliance | pas de supervision ; l'API continue |
| Add-in | `deploy/oao-addin` | bundle statique + manifests | le volet ne se charge plus (les données restent) |
| Base | `statefulset/oao-postgres` | audit, policies, index pgvector | **arrêt total** : rien n'est audité, donc rien ne doit tourner |
| Migrations | `job/oao-migrate` (hook Helm) | schéma | un upgrade ne démarre pas |
| Sauvegarde | `cronjob/oao-backup` | `pg_dump` quotidien | perte de données en cas de sinistre |
| Laya (optionnel) | `deploy/oao-laya` + PVC `oao-laya-models` | décisions structurées (urgence, domaine, dossier…) | repli automatique sur le LLM ; **aucune** indisponibilité de l'API (§16) |

Le worker s'élit leader via un **advisory lock PostgreSQL** : un redémarrage
progressif ne peut pas produire deux ordonnanceurs simultanés. Garder
`replicaCount: 1` — une seconde réplique attendrait le verrou sans rien faire.

## 2. Santé et probes

| Endpoint | Sert à | Sémantique |
|---|---|---|
| `GET /api/v1/live` | liveness Kubernetes | le processus répond. Un échec ⇒ redémarrage du pod |
| `GET /api/v1/ready` | readiness Kubernetes | dépendances joignables (base, modèle). Un échec ⇒ retrait du Service, **pas** de redémarrage |
| `GET /api/v1/health` | supervision humaine | `ok` / `degraded` / `down` + détail par dépendance |
| `GET /metrics` | Prometheus | exposition prom-client, protégée par `METRICS_TOKEN` |
| `GET /healthz` (add-in) | nginx | `200 ok` |
| `GET /api/health` (admin) | Next.js | `200` |

```bash
kubectl -n oao get pods -o wide
kubectl -n oao describe deploy/oao-api | sed -n '/Conditions/,$p'
curl -sS https://api.oao.northbridge.example/api/v1/health | jq
npm run smoke -- --url https://api.oao.northbridge.example --token "$JWT"
```

Distinguer les deux échecs : `live` KO = bug/blocage du processus ; `ready` KO
= dépendance externe. Laya n'intervient jamais dans `ready` : quand il est
activé, `/api/v1/health` ajoute un check `laya` (dégradé si injoignable ; le
statut global n'est dégradé qu'en mode `active`). Un pod qui boucle en `CrashLoopBackOff` alors que
`ready` seul échouait signale une liveness mal réglée, pas une panne.

## 3. Métriques

Prometheus **est** fourni sur NKP (kube-prometheus-stack via Kommander) et le
chart livre tout ce qu'il faut pour l'utiliser : un `ServiceMonitor`, un
`PrometheusRule` de 9 alertes et un dashboard Grafana (ConfigMap labellisée
`grafana_dashboard: "1"`). Rien à écrire à la main.

`/metrics` est protégé par `METRICS_TOKEN` (bearer, comparaison à temps
constant) et n'est joignable que depuis le namespace de monitoring
(NetworkPolicy). Le `ServiceMonitor` cible les Services `oao-api` **et**
`oao-worker` : `oao_mailbox_sync_lag_seconds` et la profondeur de file du
worker n'existent que sur ce dernier.

Catalogue exact — c'est le contenu de `apps/orchestrator/src/metrics.ts`,
préfixe `oao_` :

### HTTP

| Métrique | Type | Labels | Lecture |
|---|---|---|---|
| `oao_http_requests_total` | counter | `method`, `route`, `status` | trafic et taux d'erreur |
| `oao_http_request_duration_seconds` | histogram | `method`, `route`, `status` | latence p50/p95/p99 |

### Modèle (c'est la facture GPU)

| Métrique | Type | Labels | Lecture |
|---|---|---|---|
| `oao_llm_calls_total` | counter | `model`, `use_case`, `outcome`, `priority` | appels réellement émis ; `outcome` ∈ `ok`/`error`/`timeout`/`circuit_open`/… |
| `oao_llm_call_duration_seconds` | histogram | `model`, `use_case` | latence GPU (hors attente en file) |
| `oao_llm_queue_wait_seconds` | histogram | `model`, `priority` | temps d'attente d'un slot |
| `oao_llm_tokens_total` | counter | `model`, `kind` (`prompt`/`completion`) | volume de tokens |
| `oao_llm_queue_depth` | gauge | `lane` (`pending`/`running`) | saturation de la file |
| `oao_llm_queue_running` | gauge | — | alias plat de `lane="running"` (dashboard) |
| `oao_llm_circuit_open` | gauge | — | `1` = circuit breaker ouvert |

Ratio à suivre : `oao_llm_calls_total{outcome="ok"}` / `oao_http_requests_total`
= appels modèle par requête. C'est le chiffre sur lequel se juge le travail de
minimisation de charge IA.

### Caches, triage, coalescing

| Métrique | Type | Labels | Lecture |
|---|---|---|---|
| `oao_cache_events_total` | counter | `cache`, `result` (`hit`/`miss`) | forme canonique |
| `oao_cache_hits_total` / `oao_cache_misses_total` | counter | `cache` (`analysis`/`embedding`) | alias plats consommés par le dashboard et les alertes |
| `oao_coalesced_requests_total` | counter | `kind` | requêtes identiques ayant rejoint un appel déjà en vol |
| `oao_triage_total` | counter | `kind`, `skipped` | répartition du triage heuristique |
| `oao_model_calls_saved_total` | counter | `reason` (`triage`/`cache`/`precomputed`/`coalesced`) | appels évités — le KPI de `AI_LOAD.md` |

### Worker, audit, build

| Métrique | Type | Labels | Lecture |
|---|---|---|---|
| `oao_mailbox_sync_runs_total` | counter | `outcome`, `mode` (`obo`/`app`) | succès/échec des cycles |
| `oao_mailbox_sync_lag_seconds` | gauge | `user` | fraîcheur de la synchronisation par boîte |
| `oao_mailbox_sync_messages_total` | counter | `stage` | messages traités par étape |
| `oao_precomputed_analyses` | gauge | — | analyses précalculées vivantes |
| `oao_daily_briefs_total` | counter | `source` | briefs générés |
| `oao_audit_events_total` | counter | `type` | volume d'événements audités |
| `oao_db_up` | gauge | — | `1` si la base a répondu à la dernière readiness |
| `oao_build_info` | gauge | `version`, `role` | version et rôle déployés (toujours `1`) |

S'y ajoutent les métriques par défaut de prom-client (`oao_process_*`,
`oao_nodejs_*` : CPU, RSS, event-loop lag, handles), utiles pour distinguer une
saturation applicative d'une saturation GPU.

Les KPI **métier** (emails résumés, brouillons, automatisations approuvées,
alertes de conformité, erreurs évitées) restent exposés par
`GET /api/v1/audit/stats` et affichés dans le dashboard admin — ils ne
dupliquent pas les métriques d'infrastructure.

Dashboard Grafana : **Outlook AI Orchestrator** (uid `oao-overview`).

```bash
# Vérifier que le scrape fonctionne
kubectl -n oao get servicemonitor oao -o yaml | head -30
kubectl -n oao run -it --rm curl --image=curlimages/curl --restart=Never -- \
  curl -sS -H "Authorization: Bearer $METRICS_TOKEN" http://oao-api:8080/metrics | head
```

## 4. Catalogue d'alertes

Règles livrées par le chart (`PrometheusRule oao`, seuils dans
`metrics.prometheusRule.thresholds`) :

| Alerte | Déclenchement | Gravité | Première action |
|---|---|---|---|
| `OaoApiDown` | aucune cible `-api` UP pendant 5 min | critical | `kubectl -n oao get pods`, `describe`, `logs --previous` ; vérifier Postgres et le nœud |
| `OaoReadinessFailing` | container `orchestrator` non ready 10 min | warning | `GET /api/v1/health` : quelle dépendance est KO ? |
| `OaoLlmCircuitOpen` | `oao_llm_circuit_open == 1` pendant 5 min | critical | §11 — le produit tourne en mode dégradé |
| `OaoLlmErrorRateHigh` | > 25 % d'appels LLM en échec sur 10 min | warning | saturation GPU, `--served-model-name`, timeout |
| `OaoHttp5xxRateHigh` | > 5 % de 5xx sur 5 min | critical | logs par `correlationId`, état de Postgres |
| `OaoLatencyHigh` | p95 > 15 s sur 10 min | warning | `oao_llm_queue_depth`, latence GPU, index Postgres |
| `OaoMailboxSyncLag` | retard de sync > 60 min | warning | §12 |
| `OaoWorkerAbsent` | aucune cible `-worker` UP 15 min | warning | pas de brief ni de rétention : redémarrer le worker |
| `OaoDatabaseUnreachable` | `oao_db_up == 0` pendant 5 min | critical | **incident compliance** : plus rien n'est audité, §14 |
| `OaoLayaCircuitOpen` *(si Laya activé)* | `oao_laya_circuit_state == 2` pendant 10 min | warning | §16 — décisions repliées sur le LLM |
| `OaoLayaErrorRateHigh` *(si Laya activé)* | > 20 % d'appels Laya en échec sur 15 min | warning | `oao_laya_requests_total{outcome}` : clé, poids, saturation |
| `OaoLayaLowConfidenceRateHigh` *(si Laya activé)* | > 50 % des domaines sous le seuil sur 2 h | info | taxonomie ou seuils à revoir ([`LAYA.md`](LAYA.md) §7) |

Toute alerte `critical` doit joindre l'astreinte ; `OaoDatabaseUnreachable` et
`OaoApiDown` justifient l'ouverture d'un incident formel (traçabilité).

## 5. Logs et requêtes utiles

- Logs structurés JSON (`pino`), niveau via `config.logLevel`. Chaque requête
  porte un `request-id` corrélé au `correlationId` des `AuditEvent`.
- Le corps des emails n'est **jamais** journalisé ; les secrets sont rédigés
  (`***`) par le module `util/secrets`.

```bash
# Suivre l'API et le worker
kubectl -n oao logs -f -l app.kubernetes.io/component=orchestrator-api --max-log-requests=6
kubectl -n oao logs -f deploy/oao-worker

# Erreurs des 15 dernières minutes
kubectl -n oao logs -l app.kubernetes.io/component=orchestrator-api --since=15m \
  | jq -c 'select(.level >= 50)'

# Suivre une requête de bout en bout
kubectl -n oao logs -l app.kubernetes.io/component=orchestrator-api --since=1h \
  | jq -c 'select(.["request-id"] == "<id>")'

# Crash au démarrage
kubectl -n oao logs deploy/oao-api --previous
kubectl -n oao describe pod -l app.kubernetes.io/component=orchestrator-api
```

Côté base, pour recouper avec l'audit :

```sql
-- Les 20 derniers événements d'un utilisateur
SELECT timestamp, type, risk_level, latency_ms, correlation_id
FROM audit_events WHERE user_email = $1 ORDER BY timestamp DESC LIMIT 20;

-- Volume par type sur 24 h (doit être non nul sous trafic)
SELECT type, count(*) FROM audit_events
WHERE timestamp > now() - interval '24 hours' GROUP BY type ORDER BY 2 DESC;
```

## 6. Mises à jour, rollback, migrations

### Mise à jour applicative (GitOps, chemin nominal)

```bash
# 1. Publier la version : un tag git déclenche release.yml
git tag v1.2.3 && git push origin v1.2.3
# 2. Bump de l'image dans l'overlay d'environnement (PR revue)
#    infra/gitops/envs/prod/values.yaml -> image.tag: "1.2.3"
# 3. Flux applique : Job de migration (hook pre-upgrade) puis rollout
flux reconcile kustomization oao-prod --with-source
flux get helmreleases -n oao
kubectl -n oao rollout status deploy/oao-api
```

`maxUnavailable: 0` + PDB `minAvailable: 1` : le rollout de l'API est sans
coupure. Le worker utilise `strategy: Recreate` (l'advisory lock interdit deux
ordonnanceurs) : une courte interruption des jobs de fond est normale.

### Rollback

```bash
flux suspend helmrelease oao -n oao         # rendre la main à Helm
helm history oao -n oao
helm rollback oao <revision> -n oao
# puis corriger le dépôt (tag/valeurs) et
flux resume helmrelease oao -n oao
```

Flux remédie déjà automatiquement : `upgrade.remediation.retries: 2` avec
`strategy: rollback`. Un rollback applicatif **ne défait pas** une migration
SQL : les migrations doivent rester rétro-compatibles d'une version à la
suivante (ajout de colonnes nullable, pas de `DROP` dans la même version).

### Migrations

- Nominal : hook Helm `pre-install,pre-upgrade` → `job/oao-migrate`.
- En cas d'échec, le Job et ses ConfigMap/Secret hook-scoped sont **conservés** :

```bash
kubectl -n oao logs job/oao-migrate
kubectl -n oao describe job/oao-migrate
# Corriger, puis relancer l'upgrade (le Job est recréé) :
flux reconcile helmrelease oao -n oao
```

- Manuellement, hors Helm :

```bash
kubectl -n oao run oao-migrate-manual --rm -it --restart=Never \
  --image=ghcr.io/northbridge-capital/oao-orchestrator:1.2.3 \
  --env=DATABASE_URL="$DATABASE_URL" \
  -- node apps/orchestrator/dist/adapters/db/migrate.js
```

- `migration.autoAtBoot=true` (`DB_AUTO_MIGRATE`) existe pour le bootstrap avec
  External Secrets ; à repasser à `false` ensuite (deux répliques qui migrent
  au démarrage se marchent dessus).

## 7. Scaling et capacité (50 utilisateurs)

Hypothèses de dimensionnement retenues : 50 utilisateurs, ~120 emails
analysés par utilisateur et par jour, pic de 3× entre 08:00 et 10:00, cache
d'analyse à ~40 % de hit.

| Ressource | Réglage livré | Marge |
|---|---|---|
| API | 2 répliques, `500m/1Gi` → `2 CPU/2Gi` | HPA jusqu'à 6 répliques (CPU 70 %) |
| Worker | 1 réplique, `500m/1Gi` | non scalable horizontalement (par construction) |
| Dashboard | 1 réplique, `250m/512Mi` | quelques utilisateurs simultanés |
| Add-in | 2 répliques, `50m/64Mi` | fichiers statiques, coût négligeable |
| PostgreSQL | 1 CPU/2Gi, PVC 20 Gi | ~6 000 emails indexés/jour ⇒ ≈ 8 Gi/an avec `INDEX_RETENTION_DAYS=365` |
| Débit LLM | `LLM_CONCURRENCY=4` | c'est le **vrai** facteur limitant : ajouter des répliques d'API ne crée pas de GPU |

Scaling :

```bash
# Ajuster les bornes de l'HPA (via git/values, pas kubectl edit)
# orchestrator.api.autoscaling: { minReplicas: 2, maxReplicas: 8 }
kubectl -n oao get hpa oao-api
kubectl -n oao top pods
```

Scaling sur le trafic plutôt que sur le CPU : renseigner
`orchestrator.api.autoscaling.targetRequestsPerSecond`. Cela ajoute une
métrique `Pods` à l'HPA et suppose un `prometheus-adapter` exposant la métrique
custom `oao_http_requests_per_second`, qu'il faut définir soi-même à partir de
`rate(oao_http_requests_total[2m])` — l'orchestrator n'expose pas cette métrique
dérivée. Laisser la valeur vide tant que l'adapter n'est pas en place : l'HPA
reste alors piloté par le CPU seul.

Signaux de saturation, dans l'ordre d'apparition :

1. `oao_llm_queue_depth` durablement > `LLM_CONCURRENCY` → GPU saturé ;
2. p95 `oao_http_request_duration_seconds` qui dérive → idem ;
3. CPU des pods API > 70 % → l'HPA prend le relais ;
4. `pg_stat_activity` avec des attentes longues → augmenter `DB_POOL_MAX`
   **et** `postgres.parameters.maxConnections` de concert.

Croissance du stockage :

```sql
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

Prévoir un redimensionnement du PVC (la StorageClass `nutanix-volume` supporte
l'expansion en ligne) quand l'occupation dépasse 70 %.

## 8. Secrets et rotation

| Secret | Emplacement | Cadence | Procédure |
|---|---|---|---|
| `AAD_CLIENT_SECRET` | Secret SOPS / ESO | avant expiration Entra ID | créer le nouveau secret **avant** de révoquer l'ancien (fenêtre de recouvrement), déployer, puis révoquer |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_SECRET` | idem | 12 mois / à chaque départ | idem ; `AUTH_SECRET` invalide les sessions du dashboard |
| `ADMIN_API_TOKEN` | idem | 90 jours ou départ | changer, redémarrer API **et** dashboard ensemble |
| `METRICS_TOKEN` | idem | 90 jours | redémarrer l'API ; Prometheus relit le Secret automatiquement |
| `LLM_API_KEY` | idem | selon l'équipe GPU | souvent vide en interne |
| `outlook-ai-laya` (`api-key`) | Secret dédié (Laya ↔ orchestrateur) | 90 jours | modifier le Secret puis `rollout restart deploy/oao-laya deploy/oao-api deploy/oao-worker` **ensemble** (sinon 401 → circuit ouvert → repli LLM, sans panne) |
| `POSTGRES_PASSWORD` / `DATABASE_URL` | idem | selon politique DB | `ALTER ROLE … PASSWORD` puis mise à jour du Secret, puis rollout |
| Certificats TLS | cert-manager | automatique (`renewBefore: 360h`) | `kubectl -n oao get certificate` |

Rotation avec SOPS :

```bash
sops infra/gitops/envs/prod/secrets.enc.yaml    # édition en clair, chiffrement au save
git commit -am "chore(secrets): rotate ADMIN_API_TOKEN" && git push
flux reconcile kustomization oao-prod --with-source
kubectl -n oao rollout restart deploy/oao-api deploy/oao-worker deploy/oao-admin
```

Les secrets sont montés en **fichiers** (`/run/secrets/oao/<NOM>`) et lus via
`<NOM>_FILE` : ils n'apparaissent ni dans l'environnement du pod, ni dans
`kubectl describe pod`. Un `rollout restart` est donc nécessaire pour prendre
en compte une nouvelle valeur.

## 9. Sauvegardes et restauration

Deux niveaux, complémentaires :

1. **Snapshots de volume** (Nutanix CSI / VolumeSnapshot) : restauration
   rapide, cohérence au niveau bloc.
2. **Dump logique** (`cronjob/oao-backup`, `pg_dump -Fc`, quotidien 01:30 UTC,
   rétention 14 jours) : portable, permet la restauration partielle et la
   migration de version majeure.

```bash
# État des sauvegardes
kubectl -n oao get cronjob oao-backup
kubectl -n oao get jobs -l app.kubernetes.io/component=backup
kubectl -n oao logs job/<dernier job de backup>

# Sauvegarde à la demande
kubectl -n oao create job --from=cronjob/oao-backup oao-backup-manual
```

### Restauration

```bash
# 1. Arrêter les écritures
kubectl -n oao scale deploy/oao-api deploy/oao-worker --replicas=0

# 2. Restaurer le dump (sur une base VIDE de préférence)
kubectl -n oao exec -i statefulset/oao-postgres -- \
  pg_restore -U oao -d oao --clean --if-exists --no-owner < oao-20260101T013000Z.dump

# 3. Vérifier le schéma et l'extension
kubectl -n oao exec statefulset/oao-postgres -- \
  psql -U oao -d oao -c "SELECT extname FROM pg_extension;"        # doit contenir 'vector'
kubectl -n oao exec statefulset/oao-postgres -- \
  psql -U oao -d oao -c "SELECT count(*) FROM audit_events;"

# 4. Réappliquer les migrations manquantes puis redémarrer
kubectl -n oao create job oao-migrate-restore \
  --from=cronjob/oao-backup --dry-run=client -o yaml   # ou §6 "manuellement"
kubectl -n oao scale deploy/oao-api --replicas=2
kubectl -n oao scale deploy/oao-worker --replicas=1
```

**Tester la restauration au moins une fois par trimestre** sur un namespace
isolé (`oao-restore-test`), jamais sur la production, et consigner le résultat
— c'est la preuve attendue par un régulateur, pas l'existence du CronJob.

Tables critiques : `audit_events` (trace légale), `policies`, `automations`,
`escalations`. L'index `email_index` (pgvector) est reconstructible : sa perte
dégrade la recherche sémantique sans perte de conformité.

## 10. DR — RPO / RTO

| Scénario | RPO visé | RTO visé | Moyen |
|---|---|---|---|
| Perte d'un pod / d'un nœud | 0 | < 2 min | 2 répliques API + PDB, PVC réattaché par le CSI |
| Corruption logique (mauvaise purge, bug) | ≤ 24 h | < 2 h | dump `pg_dump` quotidien + rejeu des migrations |
| Perte du PVC PostgreSQL | ≤ 24 h | < 4 h | dump quotidien (+ snapshot CSI si activé : RPO ≈ 1 h) |
| Perte du cluster NKP | ≤ 24 h | < 8 h | tout est en git (chart + GitOps) : re-bootstrap Flux sur un cluster neuf, restauration du dump |
| Perte du registre GHCR | 0 | < 4 h | images reconstructibles depuis un tag git ; miroir interne recommandé |

Hypothèses : sauvegarde quotidienne à 01:30 UTC, secrets disponibles dans le
coffre, DNS modifiable sous 1 h. Le RPO effectif est l'âge du dernier dump :
passer à `schedule: "0 */6 * * *"` si un RPO de 6 h est exigé par la
compliance.

Non couvert par défaut : PostgreSQL n'est **pas** en haute disponibilité
(1 réplique). Pour un RTO < 5 min sur panne de base, utiliser un PostgreSQL
managé/HA externe (`postgres.enabled=false`, `postgres.external.*`).

## 11. Panne du modèle IA

Comportement attendu (dégradation contrôlée, jamais de panne totale) :

| Panne | Comportement | Visible via |
|---|---|---|
| **LLM injoignable** | analyse heuristique (règles/regex), `confidence ≤ 0.3`, risque `ai_output_unreliable`, `AuditEvent` de type `error`. `/api/v1/health` → `degraded` | `oao_llm_circuit_open`, alerte `OaoLlmCircuitOpen` |
| **Sortie LLM invalide (JSON malformé)** | tentative de réparation, puis repli dégradé identique | `oao_llm_calls_total{outcome="fallback"}` |
| **File saturée** | requêtes en attente jusqu'à `LLM_QUEUE_TIMEOUT_MS`, puis erreur explicite | `oao_llm_queue_depth` |
| **Graph indisponible** | les actions serveur renvoient `pending_client` + `clientInstruction` (l'add-in exécute l'équivalent via Office.js) | `/api/v1/health` |
| **PostgreSQL indisponible** | démarrage refusé (fail-fast) ; en vol, readiness KO ⇒ retrait du Service | `oao_db_up`, `OaoDatabaseUnreachable` |

Diagnostic :

```bash
npm run check:llm                       # depuis un poste ayant la même route réseau
kubectl -n oao exec deploy/oao-api -- node -e "fetch(process.env.LLM_BASE_URL+'/models').then(r=>console.log(r.status)).catch(e=>console.log('KO',e.message))"
kubectl -n oao get networkpolicy oao-api -o yaml | grep -A5 ipBlock
```

Trois causes par ordre de fréquence : CIDR GPU absent de `llm.egress.cidrs`
(NetworkPolicy en default-deny), `LLM_MODEL` qui ne correspond pas au
`--served-model-name`, GPU saturé.

Repli temporaire assumé : `llm.provider: mock` rend le service utilisable mais
**sans valeur ajoutée IA** — à n'utiliser que pour isoler une panne, jamais
comme état durable (les analyses produites seraient trompeuses).

## 12. Worker de synchronisation

Le pod worker exécute trois jobs, tous sur le **leader** élu par advisory lock
PostgreSQL (`apps/orchestrator/src/workers/index.ts`) :

| Job | Cadence | Conditions | Ce qu'il fait |
|---|---|---|---|
| `mailbox-sync` | toutes les `SYNC_INTERVAL_MINUTES` (premier tick au démarrage) | `PRECOMPUTE_ENABLED=true` **et** `GRAPH_ENABLED=true` | delta Graph → indexation → triage → analyse en arrière-plan (priorité `background`), au plus `SYNC_MAX_MESSAGES_PER_RUN` messages par boîte |
| `daily-brief` | une fois par jour à `DAILY_BRIEF_HOUR`, dans `TZ` | `DAILY_BRIEF_ENABLED=true` | un brief par boîte synchronisée, construit à partir des analyses **déjà calculées** : un seul appel modèle court par utilisateur |
| `retention` | toutes les 24 h | toujours | purge `audit_events` (`AUDIT_RETENTION_DAYS`), l'index (`INDEX_RETENTION_DAYS`), les caches expirés et les enregistrements `Idempotency-Key` (`IDEMPOTENCY_TTL_HOURS`) |

Le périmètre des boîtes vient de `SYNC_GROUP_ID` (recommandé : le même groupe
que l'Exchange application access policy) ou de `SYNC_USERS`. En
`GRAPH_AUTH_MODE=app`, la configuration est refusée au démarrage si aucun des
deux n'est renseigné.

États exposés par `GET /api/v1/mailbox/sync` (`MailboxSyncStatusSchema`) et
affichés par le `SyncStatusPill` du volet et la page `/system` du dashboard :

| `state` | Signification | Action |
|---|---|---|
| `disabled` | `GRAPH_ENABLED=false` ou `PRECOMPUTE_ENABLED=false` | normal si le précalcul n'est pas activé |
| `idle` | dernier cycle terminé, prochain planifié (`nextSyncAt`) | rien |
| `syncing` | cycle en cours | attendre ; si l'état colle, voir le tableau ci-dessous |
| `error` | dernier cycle en échec, détail dans `lastError` | logs du worker, §8 (secrets), politique Exchange |

Les autres champs — `lastSyncAt`, `nextSyncAt`, `indexedEmails`,
`precomputedAnalyses`, `pending` — permettent de distinguer « rien à faire » de
« bloqué ».

```bash
kubectl -n oao logs -f deploy/oao-worker
kubectl -n oao get deploy oao-worker -o jsonpath='{.spec.replicas}'   # doit valoir 1
kubectl -n oao get cm oao-config -o jsonpath='{.data.TZ}{"\n"}'        # fuseau du brief
```

| Symptôme | Cause probable | Action |
|---|---|---|
| `oao_mailbox_sync_lag_seconds` qui croît | worker arrêté, ou cycle plus long que `SYNC_INTERVAL_MINUTES` | vérifier le pod, augmenter l'intervalle ou réduire `SYNC_MAX_MESSAGES_PER_RUN` |
| `403` Graph par boîte | l'utilisateur n'est pas dans le groupe de l'application access policy | l'ajouter au groupe, ou l'exclure de `SYNC_USERS` |
| `401` Graph global | `AAD_CLIENT_SECRET` expiré | §8 |
| Aucun cycle ne démarre | `WORKERS_ENABLED=false`, ou `ROLE` mal réglé | vérifier le ConfigMap `oao-config` |
| Deux ordonnanceurs suspectés | `replicaCount > 1` | remettre à 1 ; l'advisory lock protège, mais la configuration est fausse |
| Daily brief non envoyé | `DAILY_BRIEF_HOUR` interprété dans un autre fuseau | l'ordonnanceur utilise `TZ` (`config.timezone` du chart, `Europe/Zurich` par défaut, `UTC` si la variable n'est pas posée) : vérifier `oao-config` |
| Aucune métrique worker dans Prometheus | `orchestrator.worker.role=worker` : le processus n'ouvre aucun port | repasser à `role: all` (défaut) ou accepter la perte de `oao_mailbox_sync_lag_seconds` |

Relance propre d'un cycle : `kubectl -n oao rollout restart deploy/oao-worker`
(le verrou est libéré à l'arrêt du pod).

## 13. Rétention et purge de l'audit

`audit_events` est la **trace légale** du système. La rétention est appliquée
par le worker selon `AUDIT_RETENTION_DAYS` (730 par défaut, 1095 dans les
values NKP) et `INDEX_RETENTION_DAYS`.

- Ne jamais purger sans validation compliance et sans sauvegarde préalable.
- Exporter avant suppression si une obligation de conservation externe existe :
  `GET /api/v1/audit/export` (CSV), archivé hors ligne.
- Réduire `AUDIT_RETENTION_DAYS` est une **décision de conformité**, pas une
  décision technique : elle se documente et se fait valider.

Purge exceptionnelle, validée, sous sauvegarde :

```sql
BEGIN;
SELECT count(*) FROM audit_events WHERE timestamp < now() - interval '36 months';
DELETE FROM audit_events WHERE timestamp < now() - interval '36 months';
-- Vérifier le compte attendu avant de valider
COMMIT;
```

## 14. Incidents fréquents

| Symptôme | Cause probable | Action |
|---|---|---|
| `502 llm_unavailable` sur les endpoints IA | endpoint LLM injoignable ou modèle mal nommé | §11 |
| `503 graph_unavailable` | jeton Graph expiré / secret Entra ID expiré | §8, repli `graph.enabled=false` |
| Volet refusé par Outlook | chaîne TLS inconnue du poste, ou en-têtes | CA interne par GPO ; vérifier `Content-Security-Policy: frame-ancestors …` et l'**absence** de `X-Frame-Options` |
| `401` généralisé après déploiement | `auth.aad.*` incorrects, ou horloge du nœud désynchronisée (validation `exp`/`nbf`) | vérifier les valeurs, `date -u` sur les nœuds vs NTP |
| Dashboard vide malgré du trafic | `ADMIN_API_TOKEN` désaligné entre API et dashboard, ou `ADMIN_MOCK=true` | aligner le secret, `admin.mock: false` |
| Explosion des alertes de conformité | `policies` modifiée (patterns trop larges) | comparer avec `policy_updated` dans l'audit, ajuster via le Policy Center |
| Automatisation déclenchée trop tôt | statut ≠ `active` mais déclenchée manuellement | seule une automatisation `active` doit s'exécuter ; vérifier le statut |
| `job/oao-migrate` en `BackoffLimitExceeded` | image absente du registre, base pas prête, migration en erreur | `kubectl -n oao logs job/oao-migrate` |
| Pods `Pending` | PVC non provisionné, ressources insuffisantes | `kubectl -n oao describe pod`, `kubectl get sc`, `kubectl describe node` |
| Trafic bloqué après un changement réseau | NetworkPolicy default-deny + flux non déclaré | `kubectl -n oao get networkpolicy`, ajouter le CIDR/namespace nécessaire |
| **`oao_db_up == 0`** | PostgreSQL injoignable | **incident compliance** : plus aucune action n'est auditée. Suspendre le service (`scale --replicas=0`) plutôt que de servir sans audit, restaurer, documenter |
| `/ready` → 503 `vector dimension mismatch: column N, config M` | la colonne `email_index.embedding` est en `vector(N)` mais `EMBEDDING_DIMENSIONS=M` (typiquement une base migrée avant l'existence du `.env`, donc en 1024, puis un modèle en 1536) | §15 |
| `POST /index/emails` → `mode: "lexical"` + `warning` | embeddings impossibles (dimension incohérente, pgvector absent, endpoint d'embedding HS) | la recherche par mots-clés fonctionne ; §15, puis réindexer |
| `500 database_error` | erreur PostgreSQL (le message réel est dans le log, avec le `correlationId` de la réponse) | `kubectl -n oao logs deploy/oao-api \| grep <correlationId>` |
| `/health` → `checks.vectors.status = "degraded"` | pgvector n'est pas installé : recherche lexicale seule, `embeddingsEnabled=false` | mode **supporté** ; installer l'extension puis relancer le Job de migration si la recherche sémantique est voulue |

---

## 15. Dimension des embeddings (pgvector)

### Le problème

`email_index.embedding` est une colonne **`vector(N)`** créée par la migration
`0001_init.sql`, où `N` est la valeur de `EMBEDDING_DIMENSIONS` **au moment de
cette migration** (1024 par défaut). Aucune migration ne la redimensionne
ensuite. Si la configuration change de modèle d'embedding — par exemple
`text-embedding-3-small` (1536) alors que la base a été migrée sans `.env`,
donc en 1024 — PostgreSQL refuse chaque écriture :

```
DatabaseError: expected 1024 dimensions, not 1536      -- SQLSTATE 22000
```

Le service **ne renvoie plus 500** pour autant (voir « Comportement en
dégradé »), mais la recherche sémantique est perdue tant que la colonne et la
configuration ne sont pas d'accord.

### Détection

Le garde-fou tourne à chaque démarrage (après les migrations) et dans le Job de
migration. Il lit la dimension réelle dans le catalogue
(`pg_attribute` + `format_type`), pour **toutes** les colonnes `vector(N)` du
schéma, et la compare à `EMBEDDING_DIMENSIONS`.

```bash
# Ce que la base contient réellement
psql "$DATABASE_URL" -c "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
                           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                                               JOIN pg_type t ON t.oid = a.atttypid
                          WHERE t.typname = 'vector' AND a.attnum > 0 AND NOT a.attisdropped;"

# Ce que le service en pense
curl -s https://api.oao.northbridge.example/api/v1/ready | jq .
curl -s https://api.oao.northbridge.example/api/v1/health | jq .checks.vectors
curl -s https://api.oao.northbridge.example/api/v1/config/features | jq .embeddingsEnabled
```

### Dev / démo — `DB_AUTO_MIGRATE=true`

Le démarrage **redimensionne tout seul** et le dit dans les logs :

```
WARN  vector dimension mismatch: re-dimensioning email_index.embedding vector(1024) to vector(1536) …
WARN  email_index.embedding re-dimensioned from vector(1024) to vector(1536): the stored embeddings
      were DISCARDED and will be recomputed at the next indexing
```

Ce que fait l'opération, sous le verrou d'avis des migrations (donc sans
collision entre répliques), et en une transaction :

1. `DROP INDEX IF EXISTS email_index_embedding_idx` (l'index HNSW est lié au type) ;
2. `ALTER TABLE email_index ALTER COLUMN embedding TYPE vector(N) USING NULL` —
   les vecteurs stockés ont été produits par un autre modèle, aucune conversion
   ne les rendrait corrects : ils sont **jetés**. Les lignes, elles, restent, donc
   la recherche par mots-clés continue de fonctionner sans interruption ;
3. purge des entrées de `embedding_cache` qui ne correspondent plus au modèle ou
   à la dimension courants (la table stocke des `real[]`, donc sans contrainte de
   taille : elle ne *échoue* jamais, c'est précisément pourquoi elle doit être
   invalidée explicitement) ;
4. reconstruction de l'index HNSW en `CREATE INDEX CONCURRENTLY`.

L'opération est idempotente : un second démarrage ne trouve plus rien à faire.

### Production — `DB_AUTO_MIGRATE=false`

Rien n'est modifié derrière le dos de l'exploitant. À la place :

- un log `ERROR` au démarrage ;
- `GET /api/v1/ready` → **503** avec le message exact et les deux issues
  possibles :

```json
{ "status": "unready",
  "detail": "vector dimension mismatch: column 1024, config 1536 — run the migration job or set EMBEDDING_DIMENSIONS=1024" }
```

- `GET /api/v1/health` → `checks.vectors.status = "down"` avec le même détail ;
- `GET /api/v1/config/features` → `embeddingsEnabled: false`.

Deux remèdes, à choisir explicitement :

```bash
# A. Garder le modèle d'embedding voulu et redimensionner la base (les vecteurs
#    stockés sont perdus, il faudra réindexer) :
kubectl -n oao run oao-migrate-manual --rm -it --restart=Never \
  --image=ghcr.io/northbridge-capital/oao-orchestrator:1.2.3 \
  --env=DATABASE_URL="$DATABASE_URL" --env=EMBEDDING_DIMENSIONS=1536 \
  -- node apps/orchestrator/dist/adapters/db/migrate.js
# → "email_index.embedding re-dimensioned …" puis
#   "WARNING: stored embeddings were discarded — re-index the mailboxes"

# B. Garder la base telle quelle et revenir au modèle qui produit 1024 valeurs :
#    infra/gitops/envs/prod/values.yaml → EMBEDDING_DIMENSIONS: "1024"
#    (+ EMBEDDING_MODEL cohérent), puis rollout.
```

> Prévoir la fenêtre : `ALTER COLUMN … TYPE` prend un `ACCESS EXCLUSIVE` sur
> `email_index` le temps de réécrire la table. Sur 50 boîtes c'est quelques
> secondes ; pendant ce temps l'indexation attend. La reconstruction de l'index
> HNSW, elle, est `CONCURRENTLY` et ne bloque pas les écritures.

### Réindexer (recalculer les embeddings)

Les vecteurs sont recalculés au fur et à mesure, sans intervention :
l'add-in réindexe les e-mails qu'il ouvre et le worker de synchronisation
(`PRECOMPUTE_ENABLED=true`, §12) repasse sur la boîte. Pour forcer :

```bash
# Un utilisateur, tout de suite (nécessite Graph) :
curl -s -X POST -H "Authorization: Bearer $JWT" \
  https://api.oao.northbridge.example/api/v1/mailbox/sync | jq .

# Vérifier de bout en bout que les embeddings sont revenus (mode = hybrid) :
npm run smoke -- --full --reindex --url https://api.oao.northbridge.example --token "$JWT"

# Ce qui reste sans vecteur :
psql "$DATABASE_URL" -c "SELECT count(*) AS rows, count(embedding) AS with_vector FROM email_index;"
```

### Comportement en dégradé (ce que voit l'utilisateur)

| Situation | `/index/emails` | Recherche & chat | `/ready` |
|---|---|---|---|
| Tout concorde | `mode: "hybrid"` | lexical + vectoriel (RRF) | 200 |
| Dimension incohérente, `DB_AUTO_MIGRATE=false` | `mode: "lexical"` + `warning` | lexical seul | **503** |
| pgvector absent | `mode: "lexical"` + `warning` | lexical seul | 200 (mode supporté) |
| Endpoint d'embedding HS | `mode: "lexical"` + `warning` | lexical seul | 200 |

Dans les quatre cas l'indexation **réussit** : les chunks sont stockés sans leur
vecteur, la réponse porte `warning` (champ du contrat, affiché par l'add-in) et
la recherche par mots-clés continue de répondre. Une erreur PostgreSQL qui n'est
pas rattrapable est renvoyée comme `500 database_error` avec un
`correlationId` — le message du driver reste dans les logs, jamais dans la
réponse.

## 16. Moteur de décision Laya (optionnel)

Référence complète : [`docs/LAYA.md`](LAYA.md). Laya est **optionnel et
remplaçable** : son absence ou sa panne dégrade les décisions structurées, jamais
le service (circuit breaker dédié + repli sur le prompt LLM historique ; `/ready`
n'en dépend pas).

État d'un coup d'œil :

```bash
kubectl -n oao get deploy,pod,pvc -l app.kubernetes.io/component=laya
kubectl -n oao logs deploy/oao-laya -c models          # présence des poids (init container)
curl -sS https://api.oao.northbridge.example/api/v1/health | jq '.checks.laya'
# Dashboard : Système → carte « Moteur de décision » (mode, circuit, taux de repli, latence)
```

| Symptôme | Cause probable | Action |
|---|---|---|
| Pod `oao-laya` en `Init:Error`, log `missing checkpoint(s)` (code 3) | PVC vide ou incomplet | remplir le PVC ([`LAYA.md`](LAYA.md) §11) : `laya.weights.download.enabled=true` le temps d'un démarrage (miroir interne), puis `false` |
| `oao_laya_requests_total{outcome="unauthorized"}` | clé différente entre Laya et l'orchestrateur | redémarrer les trois Deployments après toute modification du Secret `outlook-ai-laya` |
| `outcome="model_error"` (HTTP 422) | checkpoint absent du cache hors ligne, erreur de chargement | logs `kubectl -n oao logs deploy/oao-laya` ; vérifier `laya.model.checkpoints` et le PVC |
| `outcome="queue_timeout"`, latence p95 en hausse | Laya saturé (une inférence à la fois par pod) | augmenter `laya.replicaCount` **et** `LAYA_CONCURRENCY` (RWO : même nœud, ou poids embarqués) ; ou `LAYA_SHADOW_SAMPLE_RATE` < 1 en shadow |
| `outcome="timeout"` | CPU insuffisant, premier chargement | `laya.model.threads` ≤ CPU limit, `LAYA_TIMEOUT_MS`, ressources |
| `outcome="network"` | NetworkPolicy, Service, pod non prêt | `kubectl -n oao get networkpolicy oao-laya oao-api -o yaml` |
| Beaucoup de `low_confidence` | seuils non adaptés au modèle / taxonomie floue | évaluer (`npm run eval:laya`) avant de toucher aux seuils ; ne jamais les baisser « pour voir » en active |

Retour arrière (du plus léger au plus complet) :

1. `laya.mode: shadow` — réponses historiques, Laya toujours mesuré ;
2. `laya.enabled: false` — comportement historique octet pour octet (réponses,
   clés de cache, audit), le Deployment Laya disparaît, le PVC est conservé ;
3. supprimer le PVC `oao-laya-models` si Laya est abandonné.

Changer de modèle ou de poids : [`LAYA.md`](LAYA.md) §17 — toujours incrémenter
`LAYA_DECISION_VERSION` et repasser par le mode shadow.

Requêtes utiles :

```promql
sum by (outcome) (rate(oao_laya_requests_total[15m]))
histogram_quantile(0.95, sum by (le) (rate(oao_laya_request_duration_seconds_bucket[10m])))
sum by (reason) (rate(oao_laya_fallbacks_total[1h]))                 # mode active
sum by (question, result) (rate(oao_laya_shadow_comparisons_total[1d])) # mode shadow
sum by (question) (rate(oao_laya_low_confidence_total[1h]))
max(oao_laya_circuit_state)
```

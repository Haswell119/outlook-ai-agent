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

---

## 1. Carte du système

| Composant | Objet Kubernetes | Rôle | Sans lui |
|---|---|---|---|
| API | `deploy/oao-api` (`ROLE=api`) | `/api/v1/*`, `/metrics` | le volet Outlook et le dashboard sont hors service |
| Worker | `deploy/oao-worker` (`ROLE=worker`) | sync Graph, précalcul, daily brief, rétention | pas de précalcul ni de brief, l'audit n'est plus purgé |
| Dashboard | `deploy/oao-admin` | supervision, approbations compliance | pas de supervision ; l'API continue |
| Add-in | `deploy/oao-addin` | bundle statique + manifests | le volet ne se charge plus (les données restent) |
| Base | `statefulset/oao-postgres` | audit, policies, index pgvector | **arrêt total** : rien n'est audité, donc rien ne doit tourner |
| Migrations | `job/oao-migrate` (hook Helm) | schéma | un upgrade ne démarre pas |
| Sauvegarde | `cronjob/oao-backup` | `pg_dump` quotidien | perte de données en cas de sinistre |

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
pnpm smoke --url https://api.oao.northbridge.example --token "$JWT"
```

Distinguer les deux échecs : `live` KO = bug/blocage du processus ; `ready` KO
= dépendance externe. Un pod qui boucle en `CrashLoopBackOff` alors que
`ready` seul échouait signale une liveness mal réglée, pas une panne.

## 3. Métriques

`/metrics` expose le contrat prom-client suivant (préfixe `oao_`), scrapé par
le `ServiceMonitor` du chart sur les Services `oao-api` et `oao-worker` :

| Métrique | Type | Labels | Lecture |
|---|---|---|---|
| `oao_http_requests_total` | counter | `method`, `route`, `status` | trafic et taux d'erreur |
| `oao_http_request_duration_seconds` | histogram | `method`, `route` | latence p50/p95/p99 |
| `oao_llm_calls_total` | counter | `outcome` (`ok`/`error`/`timeout`/`circuit_open`/`fallback`), `model` | santé du modèle interne |
| `oao_llm_call_duration_seconds` | histogram | `model` | latence GPU |
| `oao_llm_circuit_open` | gauge | — | `1` = circuit breaker ouvert |
| `oao_llm_queue_depth` / `oao_llm_queue_running` | gauge | — | saturation de la file d'appels |
| `oao_cache_hits_total` / `oao_cache_misses_total` | counter | `cache` (`analysis`/`embedding`) | efficacité du cache |
| `oao_mailbox_sync_lag_seconds` | gauge | — | fraîcheur de la synchronisation |
| `oao_mailbox_sync_runs_total` | counter | `outcome` | succès/échec des cycles |
| `oao_audit_events_total` | counter | `type` | volume d'événements audités |
| `oao_db_up` | gauge | — | connectivité PostgreSQL |
| `oao_build_info` | gauge | `version` | version déployée |

Les KPI **métier** (emails résumés, brouillons, automatisations approuvées,
alertes de conformité, erreurs évitées) restent exposés par
`GET /api/v1/audit/stats` et affichés dans le dashboard admin — ils ne
dupliquent pas les métriques d'infrastructure.

Dashboard Grafana : **Outlook AI Orchestrator** (uid `oao-overview`), déployé
par le chart via une ConfigMap labellisée `grafana_dashboard: "1"`.

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
`orchestrator.api.autoscaling.targetRequestsPerSecond` — cela suppose
`prometheus-adapter` exposant la métrique custom
`oao_http_requests_per_second`.

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
pnpm check:llm                       # depuis un poste ayant la même route réseau
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

```bash
kubectl -n oao logs -f deploy/oao-worker
kubectl -n oao get deploy oao-worker -o jsonpath='{.spec.replicas}'   # doit valoir 1
```

| Symptôme | Cause probable | Action |
|---|---|---|
| `oao_mailbox_sync_lag_seconds` qui croît | worker arrêté, ou cycle plus long que `SYNC_INTERVAL_MINUTES` | vérifier le pod, augmenter l'intervalle ou réduire `SYNC_MAX_MESSAGES_PER_RUN` |
| `403` Graph par boîte | l'utilisateur n'est pas dans le groupe de l'application access policy | l'ajouter au groupe, ou l'exclure de `SYNC_USERS` |
| `401` Graph global | `AAD_CLIENT_SECRET` expiré | §8 |
| Aucun cycle ne démarre | `WORKERS_ENABLED=false`, ou `ROLE` mal réglé | vérifier le ConfigMap `oao-config` |
| Deux ordonnanceurs suspectés | `replicaCount > 1` | remettre à 1 ; l'advisory lock protège, mais la configuration est fausse |
| Daily brief non envoyé | `DAILY_BRIEF_HOUR` en UTC ≠ heure locale attendue | le worker raisonne en UTC : régler l'heure en conséquence |

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

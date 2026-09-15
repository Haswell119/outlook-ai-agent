# Runbook opérationnel — Outlook AI Orchestrator

> Destiné aux équipes qui exploitent le service en production (SRE / IT
> Longbow). Termes techniques laissés en anglais.

## 1. Logs

- **orchestrator** : logs structurés JSON via `pino` (niveau contrôlé par
  `LOG_LEVEL`). En dev, `pino-pretty` est utilisé automatiquement
  (`pnpm dev`). Chaque requête porte un `request-id` (corrélé à
  `correlationId` dans les `AuditEvent` correspondants) permettant de relier
  une ligne de log à une entrée d'audit.
- **Docker Compose** : `docker compose logs -f orchestrator admin addin`.
- **Kubernetes** : `kubectl -n oao logs -f deploy/orchestrator`
  (`deploy/admin`, `deploy/addin`). Pour les erreurs de démarrage :
  `kubectl -n oao describe pod <pod>`.
- **admin (Next.js)** : logs serveur (SSR) sur stdout du conteneur ; les
  erreurs client (React) ne remontent pas côté serveur — s'appuyer sur les
  retours utilisateurs + l'audit log orchestrator pour diagnostiquer.
- Ne jamais activer `AUDIT_STORE_CONTENT=true` en production sans validation
  explicite compliance : cela persiste le corps des emails dans les logs
  d'audit (voir `docs/SECURITY.md`).

## 2. Health / readiness

| Service | Endpoint | Attendu |
|---|---|---|
| orchestrator | `GET /api/v1/health` | `200`, `{"status":"ok"}` (ou `degraded` si LLM/Graph en panne, voir §6) |
| admin | `GET /` | `200` |
| addin | `GET /healthz` (nginx, HTTPS) | `200 ok` |
| postgres | `pg_isready` | healthy |

```bash
curl -s http://localhost:8080/api/v1/health | jq
./scripts/smoke-test.sh          # health + analyze/email + compliance/check + chat
```

Kubernetes : `kubectl -n oao get pods` (colonnes READY/RESTARTS),
`kubectl -n oao describe deploy/orchestrator` pour l'historique des probes.

## 3. Métriques

Le contrat `AuditStats` (`GET /api/v1/audit/stats`, consommé par le dashboard
admin — page *Overview*) expose les KPIs métier :

- emails résumés, brouillons générés, automatisations proposées/approuvées,
  alertes de conformité, "erreurs évitées" ;
- activité dans le temps (résumés / brouillons / automatisations / alertes) ;
- répartition des actions par type, alertes de conformité par catégorie ;
- taux d'approbation des automatisations, top utilisateurs.

Pour une supervision infra classique (latence, taux d'erreur HTTP, usage
CPU/mémoire), s'appuyer sur les probes Kubernetes + les logs structurés
(`latencyMs` est déjà présent sur chaque `AuditEvent`) ; brancher un
collecteur (Prometheus via un sidecar ou un exporter de logs) reste à la
charge de l'environnement cible — non fourni par ce repo.

## 4. Rotation des secrets

| Secret | Où | Rotation |
|---|---|---|
| `LLM_API_KEY` | `.env` / K8s Secret | Sur demande de l'équipe GPU interne, ou tous les 90 jours si la politique Longbow l'exige. Mettre à jour puis `kubectl -n oao rollout restart deploy/orchestrator`. |
| `AAD_CLIENT_SECRET` | `.env` / K8s Secret | Avant expiration (Azure Portal → App registration → Certificates & secrets → date d'expiration). Générer le nouveau secret **avant** de supprimer l'ancien (fenêtre de recouvrement), déployer, puis révoquer l'ancien. |
| `ADMIN_API_TOKEN` | `.env` / K8s Secret | À chaque changement de personnel ayant eu accès en clair, ou tous les 90 jours. |
| `POSTGRES_PASSWORD` | `.env` / K8s Secret | Selon la politique DB de l'environnement (managé = géré par le provider). |

Procédure générique K8s :

```bash
kubectl -n oao create secret generic oao-secrets \
  --from-literal=LLM_API_KEY=... --from-literal=AAD_CLIENT_SECRET=... \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n oao rollout restart deploy/orchestrator deploy/admin
```

## 5. Sauvegarde Postgres

- **Managé (recommandé en prod)** : utiliser les sauvegardes automatiques du
  provider (snapshots point-in-time). Vérifier que la fenêtre de rétention
  couvre au moins la durée légale de conservation de l'audit (voir
  `docs/SECURITY.md`).
- **Self-hosted (StatefulSet non-prod, ou VM dédiée)** :

  ```bash
  # Sauvegarde
  docker compose exec postgres pg_dump -U oao -Fc oao > oao_$(date +%Y%m%d).dump
  # ou en K8s :
  kubectl -n oao exec statefulset/postgres -- pg_dump -U oao -Fc oao > oao_$(date +%Y%m%d).dump

  # Restauration
  docker compose exec -T postgres pg_restore -U oao -d oao --clean --if-exists < oao_20260101.dump
  ```

- Tester la restauration périodiquement sur un environnement isolé (jamais
  directement sur la prod).
- Les tables les plus critiques à couvrir : `audit_events` (traçabilité
  légale/compliance), `policies`, `automations`, `escalations`.

## 6. Comportement de repli (dégradé)

| Panne | Comportement | Où c'est géré |
|---|---|---|
| **LLM down** | Analyse heuristique (règles/regex) uniquement, `confidence ≤ 0.3`, risque `ai_output_unreliable` ajouté, un `AuditEvent` de type `error` est écrit. `/api/v1/health` répond `degraded` sur la vérification LLM. L'utilisateur voit une réponse utilisable mais explicitement marquée peu fiable (barre de confiance basse). | `apps/orchestrator/src/domain/*`, `services/*` (dossier `ARCHITECTURE.md` §4) |
| **Graph down** | Les actions `server` (ex. `create_reminder`, `move_to_folder`) renvoient `pending_client` avec une `clientInstruction` : l'add-in exécute l'équivalent via Office.js (ex. ouvrir le formulaire de rendez-vous) au lieu d'échouer silencieusement. `/api/v1/health` répond `degraded` sur la vérification Graph si `GRAPH_ENABLED=true`. | `ActionResultStatus = pending_client` (contrat `@oao/shared`) |
| **Postgres down / DATABASE_URL=memory non voulu** | L'orchestrator ne démarre pas en mode `postgres://...` si la connexion échoue au démarrage (fail-fast) ; en K8s, la readiness probe le sort du Service jusqu'à récupération. Pas de dégradation silencieuse — utiliser `DATABASE_URL=memory` uniquement pour la démo. | `adapters/db/` |
| **LLM output invalide (JSON malformé)** | Une tentative de réparation automatique (repair retry), puis repli sur une réponse dégradée sûre si l'échec persiste (même traitement que "LLM down" côté confiance/risque). | `services/*` |

## 7. Incidents fréquents

| Symptôme | Cause probable | Action |
|---|---|---|
| `502 llm_unavailable` sur la plupart des endpoints IA | Endpoint `LLM_BASE_URL` injoignable ou modèle mal nommé | `./scripts/check-llm.sh` ; vérifier `--served-model-name` côté vLLM correspond à `LLM_MODEL` |
| `503 graph_unavailable` | Token Graph expiré / `AAD_CLIENT_SECRET` invalide ou expiré | Vérifier l'expiration du secret (Azure Portal), régénérer (§4), `GRAPH_ENABLED=false` en repli temporaire |
| Add-in refuse de charger dans Outlook | Certificat HTTPS non fiable / CSP bloque l'iframe | Vérifier `scripts/gen-dev-cert.sh` (dev) ou le certificat monté en prod ; vérifier que la réponse nginx contient bien `Content-Security-Policy: frame-ancestors ...` et **pas** `X-Frame-Options: DENY` |
| `401 unauthorized` généralisé après déploiement | `AUTH_MODE=aad` mais `AAD_TENANT_ID`/`AAD_CLIENT_ID` incorrects, ou horloge serveur désynchronisée (validation JWT `exp`/`nbf`) | Vérifier les variables, `date -u` sur le nœud vs. NTP |
| Dashboard admin vide malgré activité | `ADMIN_API_TOKEN` ne correspond pas entre `.env` orchestrator et admin, ou `ADMIN_MOCK=true` resté actif | Aligner les tokens, vérifier `ADMIN_MOCK=false` en prod |
| Alertes de conformité en nombre anormalement élevé après une mise à jour | `policies` modifiée (patterns trop larges) via `/api/v1/admin/policy` | Comparer avec la version précédente (`policy_updated` dans l'audit), ajuster via le Policy Center |
| Automatisation qui s'exécute alors qu'elle ne devrait pas encore être active | Statut `Automation.status` pas encore `active` mais un job externe l'a déclenchée manuellement | Vérifier `status` avant toute exécution manuelle ; seule `active` doit déclencher une exécution automatique |
| Job de migration (`job-migrate.yaml`) reste `Pending`/`Error` | Image orchestrator pas encore poussée sur le registre référencé, ou Postgres pas prêt | `kubectl -n oao describe job/oao-migrate` ; s'assurer que le StatefulSet/service managé Postgres est `Ready` avant d'appliquer le Job |

## 8. Purge de l'audit

L'audit (`audit_events`) est la trace légale/compliance du système — ne pas
purger sans validation de l'équipe conformité et respect de la durée légale de
conservation applicable (réglementation FINMA-friendly, voir
`docs/SECURITY.md`). Quand une purge est validée (ex. fin de rétention
contractuelle) :

```sql
-- Exemple : purge des événements de plus de N mois, hors escalades encore
-- pertinentes pour une procédure en cours (à adapter/valider avec compliance).
DELETE FROM audit_events
WHERE timestamp < now() - interval '36 months';
```

Exécuter via une migration contrôlée (pas un accès direct non tracé), avec
sauvegarde préalable (§5) et export CSV (`GET /api/v1/audit/export`) archivé
avant suppression si une obligation de conservation externe existe.

# Checklist de mise en production — Outlook AI Orchestrator

> À dérouler **dans l'ordre**, une case par ligne, avec un responsable nommé et
> une date. Rien n'est « évident » : chaque case correspond à une panne réelle
> observable si elle est sautée. Termes techniques laissés en anglais.
>
> Installation pas-à-pas : [`NKP.md`](NKP.md) · Configuration :
> [`SETUP.md`](SETUP.md) · Exploitation : [`OPERATIONS.md`](OPERATIONS.md) ·
> Sécurité : [`SECURITY.md`](SECURITY.md)
>
> Périmètre de référence : ~50 utilisateurs, Northbridge Capital, modèle interne
> Qwen3 servi par vLLM, cluster Nutanix Kubernetes Platform.

---

## 0. Préalables

| # | Vérification | Preuve attendue |
|---|---|---|
| 0.1 | CI verte sur la révision exacte à déployer | run GitHub Actions `CI` ✓ sur le SHA |
| 0.2 | Images publiées et **signées** (cosign) pour ce tag | `cosign verify ghcr.io/<owner>/oao-orchestrator:<tag> …` → OK |
| 0.3 | `Chart.yaml appVersion` == `package.json version` == tag d'image | vérifié par le job `helm` de la CI |
| 0.4 | Prérequis cluster : Traefik, cert-manager, kube-prometheus-stack, CSI, `ClusterIssuer` `Ready` | `NKP.md` §2 |
| 0.5 | Décision compliance formalisée : `AUDIT_STORE_CONTENT=false`, rétention audit retenue, matrice de gouvernance relue | PV de revue |

---

## 1. Entra ID (trois app registrations)

Détail : [`SETUP.md`](SETUP.md) §3.

- [ ] **App « API »** créée (single tenant), `Application ID URI` défini,
      scope **`access_as_user`** exposé et **Enabled**.
- [ ] `Add a client application` : client ID de l'app **Add-in** *et* client ID
      de l'app **Dashboard**, tous deux cochés sur `access_as_user`.
- [ ] **App roles `Admin` et `Compliance`** créés sur l'app API et **assignés**
      à des groupes (Enterprise applications → Users and groups).
      `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` ne sont qu'un repli temporaire.
- [ ] **App « Add-in »** (SPA) : redirect URI
      `https://<addin-host>/taskpane.html`, permission `access_as_user` sur
      l'API, `Expose an API` avec l'URI attendue par Office, admin consent donné.
- [ ] **App « Dashboard »** (Web) : redirect URI **exactement**
      `https://<admin-host>/api/auth/callback/microsoft-entra-id`.
- [ ] Dashboard → **API permissions → My APIs → API → `access_as_user`**
      (déléguée) + **Grant admin consent**. Sans cela la session ne porte pas
      d'access token d'audience `api://…` et l'orchestrator renvoie `401`.
- [ ] Dashboard : **Assignment required = Yes**, seuls les groupes
      `Admin`/`Compliance` assignés.
- [ ] Secrets clients générés, **dates d'expiration inscrites au calendrier**
      d'exploitation ([`OPERATIONS.md`](OPERATIONS.md) §8).
- [ ] Test : un compte `Admin` se connecte au dashboard, un compte sans rôle
      arrive sur `/no-access` (et non sur une 404 ni sur des données).

---

## 2. DNS et TLS

- [ ] Trois enregistrements DNS résolvent vers la VIP Traefik :
      `api.…`, `admin.…`, `addin.…` (valeurs `hosts.*` du chart).
- [ ] Certificats **réels** (PKI interne via cert-manager) sur les trois hôtes :
      `kubectl -n oao get certificate` → tous `Ready=True`.
- [ ] La **CA interne est distribuée aux postes** (GPO / MDM). Outlook refuse
      silencieusement un volet dont la chaîne TLS est inconnue — le symptôme est
      un volet vide, sans message.
- [ ] Le pod add-in termine TLS lui-même : `addin.tls.mode=certManager` et, sous
      Traefik, `addin.traefik.serversTransport` pointe sur la CA interne
      (`insecureSkipVerify: false`).
- [ ] En-têtes du host statique vérifiés depuis un poste :
      `curl -sI https://<addin-host>/taskpane.html` montre
      `Content-Security-Policy: frame-ancestors 'self' https://appsforoffice.microsoft.com …`
      (valeur de `frameAncestors()`), **aucun** `X-Frame-Options`,
      `Cache-Control: no-cache, must-revalidate`.
- [ ] `curl -sI https://<addin-host>/assets/<fichier hashé>.js` →
      `Cache-Control: public, max-age=31536000, immutable`.
- [ ] `curl -so /dev/null -w '%{http_code}\n' https://<addin-host>/assets/<fichier>.js.map`
      → **404**.

---

## 3. Endpoint IA interne validé

- [ ] `LLM_BASE_URL` / `llm.baseUrl` renseigné et joignable **depuis le
      cluster** (pas seulement depuis un poste).
- [ ] `LLM_MODEL` correspond exactement au `--served-model-name` de vLLM.
- [ ] **`LLM_FAST_MODEL` renseigné.** Laissé vide, triage-assist,
      classification, anti-phishing et extraction repartent sur le grand modèle
      et la charge GPU double quasiment
      ([`AI_LOAD.md`](../apps/orchestrator/docs/AI_LOAD.md) §6).
- [ ] `EMBEDDING_MODEL` servi sur le même endpoint (`/v1/embeddings`).
- [ ] `EMBEDDING_DIMENSIONS` == dimension réellement retournée == colonne
      `vector(N)` des migrations. Une incohérence casse l'indexation en
      silence côté écriture.
- [ ] `LLM_API_KEY` renseignée **si** l'endpoint en exige une, via le Secret
      (jamais en clair dans un values file).
- [ ] Validation exécutée et archivée :

      ```bash
      npm run check:llm              # /models + une complétion réelle + /embeddings
      ```

      Verdict OK sur les trois étapes, code de sortie 0.
- [ ] CIDR du ou des nœuds GPU déclaré dans `llm.egress.cidrs` **et** le port
      dans `llm.egress.ports`. Les NetworkPolicies sont en default-deny : un
      endpoint non déclaré est injoignable sans aucun message d'erreur réseau.

---

## 4. Secrets

- [ ] Stratégie choisie et **une seule** : `secrets.create` (values SOPS) *ou*
      `secrets.existingSecret` *ou* `externalSecrets.enabled`.
- [ ] Toutes les clés attendues existent : `LLM_API_KEY`, `AAD_CLIENT_SECRET`,
      `ADMIN_API_TOKEN`, `METRICS_TOKEN`, `DATABASE_URL`,
      `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_SECRET`, plus
      `POSTGRES_PASSWORD` si `postgres.enabled=true`. Une clé listée dans
      `secrets.existingSecretKeys` mais absente du Secret donne un
      `<NAME>_FILE` pointant sur un fichier inexistant et l'app échoue fermée.
- [ ] `ADMIN_API_TOKEN` ≥ **24 caractères** (l'orchestrator refuse de démarrer
      en dessous quand `NODE_ENV=production`).
- [ ] `AUTH_SECRET` généré par `openssl rand -base64 32` (jamais réutilisé).
- [ ] `secrets.mountAsFiles: true` : les secrets sont montés sous
      `/run/secrets/oao/<NOM>` et lus via `<NOM>_FILE`. Contrôle :
      `kubectl -n oao exec deploy/oao-api -- env | grep -c 'AAD_CLIENT_SECRET='`
      → **0**, et `… | grep AAD_CLIENT_SECRET_FILE` → présent.
- [ ] `git grep` / gitleaks ne trouvent aucune valeur sensible dans le dépôt.
- [ ] `features.demoSeed: false` et `DEMO_SEED` absent de la configuration de
      production.
- [ ] `config.apiDocsEnabled: false`, `config.auditStoreContent: false`.
- [ ] `admin.authMode: aad`. En `token` avec `NODE_ENV=production` et sans
      `ADMIN_MOCK`, le dashboard refuse de servir : `ADMIN_AUTH_MODE=token`
      distribue `ADMIN_DEV_ROLES` à quiconque ouvre la page.

---

## 5. Microsoft Graph et worker de précalcul

- [ ] Permissions **applicatives** déclarées sur l'app API (`Mail.Read`,
      `User.Read.All`) et **admin consent donné**.
- [ ] Groupe de sécurité **mail-enabled** créé pour le périmètre
      (`oao-precompute@…`).
- [ ] **Exchange application access policy** en place :

      ```powershell
      Test-ApplicationAccessPolicy -Identity pilote@northbridge.example -AppId "<client id API>"   # Granted
      Test-ApplicationAccessPolicy -Identity hors.perimetre@…          -AppId "<client id API>"   # Denied
      ```

      Les deux résultats doivent être observés, pas seulement le premier.
- [ ] `graph.sync.groupId` (ou `graph.sync.users`) renseigné — sinon
      `GRAPH_AUTH_MODE=app` est refusé au démarrage.
- [ ] `config.timezone` (`TZ`) correspond au fuseau attendu pour
      `features.dailyBriefHour`, sinon le brief part à la mauvaise heure.
- [ ] `orchestrator.worker.replicaCount: 1` (l'advisory lock protège, mais deux
      répliques est une configuration fausse).
- [ ] `orchestrator.worker.role: all` si les métriques et probes du worker sont
      attendues (défaut). En `role: worker`, le processus n'ouvre aucun port :
      ni probe HTTP, ni `oao_mailbox_sync_lag_seconds`, ni alerte
      `OaoWorkerAbsent`.
- [ ] Après déploiement : `GET /api/v1/mailbox/sync` renvoie `state: "idle"` (ou
      `syncing`) et un `lastSyncAt` récent pour un compte pilote.

---

## 6. Base de données et migrations

- [ ] PostgreSQL 16 avec l'extension **`vector`** disponible
      (`SELECT extversion FROM pg_extension WHERE extname='vector'`).
- [ ] `migration.enabled: true` et `migration.autoAtBoot: false` : le Job hook
      `pre-install`/`pre-upgrade` applique le schéma **avant** le rollout
      (`node apps/orchestrator/dist/adapters/db/migrate.js`). Le at-boot fait
      courir les répliques les unes contre les autres.
- [ ] Job de migration passé : `kubectl -n oao get jobs`, puis schéma vérifié.
- [ ] `DB_POOL_MAX` cohérent avec `postgres.parameters.maxConnections`
      (répliques API × `DB_POOL_MAX` + worker + migrations < maxConnections).
- [ ] PVC dimensionné et StorageClass extensible en ligne.

---

## 7. Réseau

- [ ] `networkPolicy.enabled: true` et `defaultDeny: true`.
- [ ] `networkPolicy.ingressController.namespaceSelector` = namespace réel de
      Traefik (`kommander` sur NKP).
- [ ] `networkPolicy.monitoring.namespaceSelector` = namespace réel de
      Prometheus, sinon **aucun** scrape n'aboutit.
- [ ] `networkPolicy.dns.namespaceSelector` = namespace de CoreDNS.
- [ ] `llm.egress.cidrs` / `ports` (§3) et, si base externe,
      `postgres.external.cidrs`.
- [ ] `networkPolicy.microsoft` : 443 sortant vers Entra ID / Graph, plages
      RFC1918 exclues (`exceptPrivateRanges: true`) ou CIDR explicites.
- [ ] Test négatif : un pod quelconque du namespace **ne joint pas**
      `oao-postgres:5432` s'il n'est pas l'orchestrator.

---

## 8. Sauvegardes

- [ ] `postgres.backup.enabled: true`, `schedule` et `retentionDays` décidés.
- [ ] Première exécution réussie : `kubectl -n oao get jobs -l app.kubernetes.io/component=backup`.
- [ ] **Restauration testée** sur un environnement isolé, avec chronométrage :
      dump → base vide → `pg_restore` → schéma et extension vérifiés → RTO
      mesuré et comparé à l'objectif ([`OPERATIONS.md`](OPERATIONS.md) §9–10).
      Une sauvegarde jamais restaurée n'est pas une sauvegarde.
- [ ] Snapshots de volume (Nutanix CSI) actifs en complément du dump logique.
- [ ] Destination des dumps hors du cluster (PVC dédié ou bucket S3/Nutanix
      Objects) et rétention conforme à la politique de conservation.

---

## 9. Observabilité et alertes

- [ ] `METRICS_TOKEN` renseigné ; sans jeton `/metrics` renvoie **401**
      (`curl -s -o /dev/null -w '%{http_code}' …/metrics`).
- [ ] Cibles `oao-api` **et** `oao-worker` `UP` dans Prometheus.
- [ ] `metrics.serviceMonitor.labels` alignés sur le `serviceMonitorSelector`
      du Prometheus de Kommander (`release: kube-prometheus-stack`), sinon le
      ServiceMonitor existe mais n'est jamais sélectionné.
- [ ] Dashboard Grafana **Outlook AI Orchestrator** (uid `oao-overview`)
      visible et alimenté.
- [ ] Les 9 règles du `PrometheusRule` sont chargées
      (`kubectl -n oao get prometheusrule oao -o yaml`).
- [ ] **Routage d'alerte testé de bout en bout** : déclencher volontairement une
      alerte (par exemple `llm.provider` pointé sur un endpoint mort →
      `OaoLlmCircuitOpen`) et vérifier la réception par l'astreinte. Une alerte
      qui n'arrive nulle part ne sert à rien.
- [ ] Seuils `metrics.prometheusRule.thresholds` revus avec l'équipe
      d'exploitation.

---

## 10. Déploiement du manifest Office

- [ ] Image add-in construite **avec les hôtes de cet environnement**
      (`ADDIN_HOST`, `API_HOST`, `AAD_CLIENT_ID`) : le bundle et les manifests
      sont figés au build, une image ne se recycle pas d'un environnement à
      l'autre.
- [ ] `VITE_API_BASE_URL` = **origine seule** (`https://api.…`), sans
      `/api/v1` : les chemins de `Routes` portent déjà le préfixe. Contrôle
      dans le bundle : aucune requête vers `/api/v1/api/v1/…`.
- [ ] Manifests servis : `https://<addin-host>/manifest/manifest.xml` et
      `…/manifest.json` répondent 200.
- [ ] `npm run validate-manifest -w @oao/addin` passe sur les fichiers
      publiés.
- [ ] **Déploiement centralisé** via Microsoft 365 admin center → *Integrated
      apps* → *Upload custom apps*, ciblé sur le **groupe pilote** uniquement
      (jamais « Everyone » au premier déploiement).
- [ ] Le groupe pilote du manifest et le groupe de l'application access policy
      sont **cohérents** (idéalement le même).
- [ ] Volet ouvert avec succès depuis : Outlook Windows, nouvel Outlook,
      Outlook on the web, Outlook macOS.
- [ ] SSO silencieux vérifié (aucune popup de consentement) et repli testé
      (`VITE_AUTH_MODE=aad`, jeton refusé → message clair, pas d'écran blanc).
- [ ] **`VITE_ONSEND_FAIL_MODE` arbitré et consigné.** `open` (défaut) : si la
      vérification de conformité à l'envoi échoue (orchestrator injoignable,
      circuit LLM ouvert), l'envoi reste autorisé avec un avertissement.
      `closed` : l'envoi est refusé tant que le contrôle ne fonctionne pas —
      toute indisponibilité de l'orchestrator devient un blocage de la
      messagerie sortante. C'est une décision de conformité, figée au build de
      l'image ([`SECURITY.md`](SECURITY.md) §10).

---

## 11. Groupe pilote et exploitation

- [ ] Groupe pilote nommé (5–10 personnes), informé, avec un canal de retour
      identifié.
- [ ] Note d'information utilisateurs : ce que fait l'IA, ce qu'elle ne fait
      **jamais** (aucun envoi, aucune suppression automatique), où va la donnée
      (modèle interne, aucun fournisseur cloud d'IA).
- [ ] `ORGANIZATION_NAME` / `ADMIN_TENANT_NAME` et `DEFAULT_LANGUAGE` /
      `ADMIN_DEFAULT_LANGUAGE` conformes à l'attendu.
- [ ] `INTERNAL_DOMAINS` et `config.corsOrigins` restreints aux domaines réels.
- [ ] Policy Center relu par la conformité : patterns sensibles, seuil
      d'approbation, `blockOnHighRisk`. Le **panneau de test de policy** du
      dashboard a été utilisé sur des brouillons réels avant enregistrement.
      Un motif refusé en `400` par `PUT /admin/policy` l'est à raison (trop
      long, syntaxe invalide, ou backtracking exponentiel) : le corriger, ne
      pas le contourner ([`SECURITY.md`](SECURITY.md) §11).
- [ ] Runbook [`OPERATIONS.md`](OPERATIONS.md) relu par l'astreinte ; qui est
      appelé, quand, pour quelle alerte.
- [ ] Revue à J+7 planifiée : `oao_model_calls_saved_total` /
      `oao_llm_calls_total`, latence p95, taux de hit du cache, retours
      qualitatifs (`/api/v1/feedback`, page *Analytics*).

---

## 12. Plan de rollback

À écrire **avant** le go-live, pas pendant l'incident.

- [ ] Version précédente identifiée (tag d'image + révision Helm) et toujours
      présente dans le registre.
- [ ] Procédure décidée selon le chemin :

      ```bash
      # GitOps (nominal) : revert de l'overlay, Flux applique
      git revert <sha du bump>  &&  git push
      flux reconcile kustomization oao-prod --with-source

      # Helm direct (bootstrap / cluster de test)
      helm -n oao history oao
      helm -n oao rollback oao <révision>
      ```

- [ ] **Migrations : décision prise à l'avance.** Une migration destructive
      n'est pas réversible par un rollback d'image. Pour ce déploiement :
      migrations additives uniquement ? sinon, sauvegarde immédiatement avant
      l'upgrade **et** procédure de restauration validée (§8).
- [ ] Repli produit documenté : `llm.provider: mock` rend le service utilisable
      sans valeur ajoutée IA — acceptable pour isoler une panne, **jamais**
      comme état durable (les analyses produites seraient trompeuses).
      `graph.enabled: false` coupe le précalcul sans casser le volet.
- [ ] Retrait du manifest : Integrated apps → l'app → *Remove*, effet sous
      quelques heures côté clients. Prévoir la communication associée.
- [ ] Critère de déclenchement du rollback écrit et chiffré (par exemple :
      `OaoHttp5xxRateHigh` > 15 min, ou `oao_db_up == 0`), et qui décide.

---

## Signatures

| Rôle | Nom | Date | Visa |
|---|---|---|---|
| Exploitation / SRE | | | |
| Sécurité | | | |
| Conformité | | | |
| Métier (sponsor) | | | |

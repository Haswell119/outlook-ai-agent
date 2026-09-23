# Laya — moteur local de décisions structurées

> **Statut : intégré, désactivé par défaut, non validé en production.**
> Le code, l'image, le chart et les tests existent ; la qualité des décisions
> sur les emails de Northbridge **n'a pas été mesurée**. Les seuils par défaut
> ne sont **pas** une preuve de calibration. Démarrer en mode `shadow`,
> annoter un jeu interne, mesurer, puis seulement décider du mode `active`.

## Sommaire

1. [Rôle de Laya](#1-rôle-de-laya)
2. [Différence avec le LLM](#2-différence-avec-le-llm)
3. [Flux de données](#3-flux-de-données)
4. [Modes disabled / shadow / active](#4-modes-disabled--shadow--active)
5. [Configuration](#5-configuration)
6. [Taxonomie](#6-taxonomie)
7. [Seuils et calibration](#7-seuils-et-calibration)
8. [Fallback](#8-fallback)
9. [Docker local](#9-docker-local)
10. [Déploiement NKP / Helm](#10-déploiement-nkp--helm)
11. [Fonctionnement hors ligne et stockage des poids](#11-fonctionnement-hors-ligne-et-stockage-des-poids)
12. [Sécurité](#12-sécurité)
13. [Observabilité](#13-observabilité)
14. [Évaluation](#14-évaluation)
15. [Rollback](#15-rollback)
16. [Limites connues](#16-limites-connues)
17. [Changer de modèle](#17-changer-de-modèle)
18. [Activer un modèle fine-tuné](#18-activer-un-modèle-fine-tuné)
19. [Version épinglée (0.3.8 → 0.3.9)](#19-version-épinglée-038--039)

---

## 1. Rôle de Laya

[Laya](https://pypi.org/project/laya/) est un modèle de décision « système 1 » :
un encodeur (ModernBERT / mmBERT) qui, pour un *state* JSON et une question à
choix, renvoie une distribution de probabilités sur les options, le choix le
plus probable et une **confiance** (entropie normalisée de la distribution). Il
tourne localement (`laya-serve`, FastAPI, CPU ou GPU), sans génération de texte.

Dans l'orchestrateur, Laya prend **cinq décisions fermées** par email :

| Question | Options | Utilisation |
|---|---|---|
| `urgency` | `low` · `normal` · `high` · `critical` | affichage, tri |
| `businessArea` | les domaines de la taxonomie (dont `other`) | classification |
| `folder` | les dossiers **du domaine retenu** | suggestion `move_to_folder` |
| `replyExpected` | `required` · `not_required` | affichage, contexte du LLM |
| `actionRequired` | `required` · `not_required` | affichage, contexte du LLM |

Le LLM garde tout ce qui est génératif : résumé, décisions, tâches et
échéances, risques rédigés, actions suggérées (hors classement), réponses
rapides, brouillons.

Laya **ne déclenche jamais d'action**. Un dossier suggéré devient au mieux une
action `move_to_folder` *proposée*, qui passe par le circuit existant
(proposition → validation humaine → exécution). Rien n'est déplacé, envoyé ou
supprimé automatiquement.

## 2. Différence avec le LLM

| | Laya | LLM (vLLM interne) |
|---|---|---|
| Sortie | un choix parmi des options fermées + probabilités | texte libre / JSON |
| Coût | ~1 s CPU par appel (mesuré, cf. §16), pas de GPU requis | GPU partagé, secondes à dizaines de secondes |
| Contexte | quelques centaines de tokens (512 / 1024) | plusieurs milliers de tokens |
| Déterminisme | même entrée → même sortie | dépend de la température |
| Injection de prompt | l'email est une donnée ; les questions sont des constantes serveur | atténuée, jamais nulle |
| Confiance | chiffrée mais **non calibrée** sur nos données (§7) | pas de confiance exploitable |

Laya ne remplace donc pas le LLM : il lui retire les décisions fermées quand
elles sont sûres, ce qui permet un prompt LLM **réduit** (sans classification,
urgence ni dossier à produire).

## 3. Flux de données

Ordre dans `AnalyzeEmailService.analyze` (`POST /api/v1/analyze/email`) :

```
triage (règles) ──► newsletter / notification / OOO : réponse heuristique, ni Laya ni LLM
      │
thread (optionnel, Graph)
      │
clé de cache (+ empreinte des décisions si activées) ──► hit : ni Laya ni LLM
      │
 ┌────┴───── mode active ─────────────────────────┐   ┌── mode shadow ──────────────────────┐
 │ Laya : urgence + domaine + réponse + action     │   │ Laya en parallèle du LLM historique  │
 │  └► domaine accepté et ≥ 2 dossiers : dossier   │   │ (abandonné 250 ms après la fin du    │
 │ politique de confiance → plan                   │   │  LLM) ; comparaison + audit + métriques│
 │  ├ décisions sûres : prompt NARRATIF réduit     │   │ réponse = historique, inchangée      │
 │  └ sinon          : prompt HISTORIQUE complet   │   └──────────────────────────────────────┘
 └──────────────────────────────────────────────────┘
      │
assemblage (classification Laya si acceptée) → actions déterministes
(move_to_folder proposé si dossier ≥ LAYA_FOLDER_MIN_CONFIDENCE
 et email non suspect de phishing) → audit → métriques
```

Le **state** envoyé à Laya est construit champ par champ
(`domain/decisions/state-builder.ts`), jamais à partir de l'objet Graph/Office :

- `language`, `subject` (≤ 300 car.), `senderType` (internal/external/unknown),
  `senderDomain` (externe seulement), `recipientCount`, `externalRecipients`,
  `importance`, `receivedAt`, `ageHours` ;
- pièces jointes : nom (≤ 80 car.) et extension — **jamais le contenu** ;
- `signals` déjà calculés (triage, anti-phishing, marqueurs d'urgence, d'échéance,
  de demande, de question, de document manquant, de confidentialité) ;
- `body` nettoyé (historique cité, signatures, disclaimers retirés ; début + fin
  conservés) et tronqué au budget du checkpoint (≈ 1 100 car. `english`,
  ≈ 2 600 `multilingual`, plafond `LAYA_INPUT_MAX_CHARS`) ;
- au plus 2 extraits (≤ 200 car.) des messages précédents du fil.

Aucune adresse email, aucun identifiant de message, aucun lien, aucun jeton.
Le state n'est **ni journalisé ni stocké** : l'audit n'en garde que le hash
SHA-256 et la taille.

## 4. Modes disabled / shadow / active

| | `DECISION_PROVIDER=disabled` (défaut) | `laya` + `LAYA_MODE=shadow` | `laya` + `LAYA_MODE=active` |
|---|---|---|---|
| Appel à Laya | jamais | oui (échantillonné : `LAYA_SHADOW_SAMPLE_RATE`) | oui |
| Réponse API | historique, **octet pour octet** | historique, inchangée | + `decisioning`, classification/urgence issues de Laya si acceptées |
| Prompt LLM | historique | historique | narratif réduit si décisions sûres, sinon historique |
| `move_to_folder` issu de Laya | non | non | oui, proposé, validation humaine |
| Clés de cache | historiques | + empreinte shadow | + empreinte active |
| Audit | historique | + bloc `decision` (sans contenu) | + bloc `decision` |
| Latence ajoutée | 0 | ≤ 250 ms au pire (Laya abandonné sinon) | temps Laya (≤ `LAYA_TIMEOUT_MS`) |

`DECISION_PROVIDER=mock` sert aux démonstrations et aux tests (heuristiques
déterministes, pas de modèle) — jamais en production.

## 5. Configuration

Toutes les variables sont validées au démarrage (zod, même mécanisme que le
reste de la configuration) ; une erreur arrête le boot **seulement si le
fournisseur est activé**.

| Variable | Défaut | Rôle |
|---|---|---|
| `DECISION_PROVIDER` | `disabled` | `disabled` · `mock` · `laya` |
| `LAYA_MODE` | `shadow` | `shadow` · `active` |
| `LAYA_BASE_URL` | `http://laya:8000` | URL http(s) sans identifiants |
| `LAYA_API_KEY` / `LAYA_API_KEY_FILE` | — | bearer partagé avec `laya-serve` ; **obligatoire en `active` + production** |
| `LAYA_TIMEOUT_MS` | `5000` | délai total d'un appel (connexion + corps) |
| `LAYA_MAX_RESPONSE_BYTES` | `1048576` | taille max de réponse lue |
| `LAYA_MIN_CONFIDENCE` | `0.75` | seuil urgence / domaine / réponse / action |
| `LAYA_FOLDER_MIN_CONFIDENCE` | `0.80` | seuil dossier |
| `LAYA_FALLBACK_TO_LLM` | `true` | Laya en échec → prompt historique (sinon : règles seules) |
| `LAYA_CONCURRENCY` | `1` | appels simultanés par pod orchestrateur (laya-serve sérialise l'inférence) |
| `LAYA_CIRCUIT_FAILURE_THRESHOLD` | `5` | échecs consécutifs avant ouverture du circuit |
| `LAYA_CIRCUIT_COOLDOWN_MS` | `30000` | durée d'ouverture avant un essai |
| `LAYA_TAXONOMY_FILE` | exemple embarqué | **obligatoire en `active` + production** ; Helm : `/etc/oao/laya-taxonomy.json` |
| `LAYA_DECISION_VERSION` | `v1` | à incrémenter pour invalider le cache après un changement de questions/modèle |
| `LAYA_INPUT_MAX_CHARS` | `4000` | plafond du state (≤ 20 000) |
| `LAYA_MODEL_STRATEGY` | `language` | `language` (english pour l'anglais, multilingual sinon) · `auto` (routage Laya) · `fixed` |
| `LAYA_FIXED_MODEL` | — | checkpoint si `fixed` (`english`, `multilingual`…) |
| `LAYA_SHADOW_SAMPLE_RATE` | `1` | part des analyses consultées en shadow (échantillon déterministe par contenu) |

## 6. Taxonomie

Fichier JSON **versionné**, validé au démarrage (zod), hors du code :
`apps/orchestrator/config/laya-taxonomy.example.json` (exemple),
`LAYA_TAXONOMY_FILE` en exploitation (Helm : ConfigMap montée).

```json
{
  "version": "v1",
  "areas": [
    { "id": "operations",
      "labels": { "fr": "Opérations", "en": "Operations" },
      "descriptions": { "fr": "Flux opérationnels, NAV…", "en": "Operational flows, NAV…" },
      "folders": [
        { "id": "nav", "displayName": "Operations/NAV", "outlookFolder": "Operations/NAV",
          "descriptions": { "fr": "Imports NAV…", "en": "NAV imports…" } }
      ] },
    { "id": "other", "labels": { "fr": "Autre", "en": "Other" },
      "descriptions": { "fr": "Aucune catégorie métier", "en": "None of the categories" }, "folders": [] }
  ]
}
```

Règles (refus au démarrage sinon) : identifiants stables `^[a-z][a-z0-9_]{0,47}$` ;
libellés et descriptions FR **et** EN, courts (60 / 160 car.), sans caractère de
contrôle ; domaine `other` obligatoire et sans dossier ; pas de doublon
(identifiants, dossiers Outlook) ; **au plus 15 options par question** — au-delà,
ajouter un niveau de hiérarchie. Avertissement au démarrage au-delà de **10**
options (confiance non calibrée par les checkpoints publiés, §7).

Classification **hiérarchique** : le domaine d'abord ; le dossier n'est demandé
que si le domaine est accepté et compte au moins deux dossiers ; un seul
dossier → déduit de la taxonomie (source `taxonomy`), `other` ou aucun dossier
→ aucun déplacement proposé.

La version et le hash de la taxonomie entrent dans les clés de cache et les
audits : changer le fichier invalide les analyses concernées.

## 7. Seuils et calibration

> **Les seuils par défaut (0,75 / 0,80) ne sont pas une preuve de calibration.**
> **Une confiance élevée n'est pas une garantie de correction.**

- La « confiance » de Laya est une **certitude du modèle sur les options qu'on lui
  donne** (entropie normalisée), pas une probabilité d'avoir raison.
- Checkpoints publiés (laya 0.3.9, `convaiinnovations/laya@5e7b2b1b`), constaté
  en chargeant les poids :
  - `multilingual` (utilisé pour le français) : **aucune calibration** (températures
    à 1,0, pas de table par nombre d'options) ;
  - `english` : calibré par nombre d'options, **sauf 11 options et plus** (température
    invalide, remplacée par Laya qui prévient que la confiance est non calibrée).
- Sur nos emails d'exemple synthétiques, les confiances observées sont **basses**
  (moyenne 0,2 à 0,5 selon la question, cf. §16) : avec les seuils par défaut, le
  mode `active` renverrait la plupart des décisions au LLM. C'est le
  comportement sûr voulu, mais le gain attendu n'existe qu'une fois des seuils
  choisis **sur des données annotées** — voire avec un modèle fine-tuné (§18).
- Le seul moyen de fixer les seuils : le *threshold sweep* du harnais d'évaluation
  (§14) sur un jeu **interne, réel, annoté**, en visant l'exactitude acceptée
  voulue (ex. ≥ 95 % pour le dossier) et en acceptant la couverture qui en découle.
- Égalité au seuil = acceptée ; confiance absente ou choix inconnu = rejeté.

## 8. Fallback

La décision ne fait **jamais** échouer une analyse et ne rend jamais
l'orchestrateur indisponible (`/ready` ne dépend pas de Laya).

| Situation | Mode active, `LAYA_FALLBACK_TO_LLM=true` | … `=false` | Mode shadow |
|---|---|---|---|
| Timeout, réseau, 5xx, 429, 401, 422 (poids absents), réponse invalide | prompt historique, `decisioning.source=llm_fallback`, `degraded=true` | prompt narratif sans ces décisions, `source=heuristic` | rien de visible ; métriques + audit |
| Circuit ouvert | idem, sans appel | idem | idem |
| Domaine sous le seuil / réponse inexploitable | prompt historique, `lowConfidence=true`, pas de dossier | prompt narratif sans domaine | idem |
| Dossier sous le seuil ou en échec | décisions acceptées conservées, pas de `move_to_folder` | idem | — |
| LLM en échec aussi | heuristiques (bannière « IA indisponible » inchangée) | idem | idem |

Une décision dégradée n'est **pas mise en cache** : l'email sera réévalué au
prochain affichage.

Résilience : file bornée (`LAYA_CONCURRENCY`, attente ≤ `LAYA_TIMEOUT_MS`),
circuit breaker dédié (distinct de celui du LLM), seuls les échecs
d'infrastructure comptent (une requête mal formée — 400 — ou un abandon ne
comptent pas ; un **422** compte, car `laya-serve` le renvoie quand son modèle
ne peut pas tourner, p. ex. poids absents).

## 9. Docker local

Le quickstart historique (`docker compose up --build`) n'est pas modifié : sans
profil, aucun service Laya ne démarre.

```bash
# 1. .env : DECISION_PROVIDER=laya, LAYA_MODE=shadow (LAYA_API_KEY optionnelle en local)
docker compose --profile laya up --build
#    laya-models : télécharge UNE fois les poids épinglés dans le volume oao_laya_models
#    laya        : laya-serve hors ligne (HF_HUB_OFFLINE=1), healthcheck /health
#    orchestrator: attend laya (healthy), LAYA_BASE_URL=http://laya:8000
npm run check:laya                                  # /health + une décision de test
npm run smoke:laya -- --laya-url http://localhost:8000 --laya-key "$LAYA_API_KEY"
```

GPU (NVIDIA, **non testé ici**) : `docker compose --profile laya -f docker-compose.yml -f docker-compose.gpu.yml up --build`
(image CUDA `cu126` par défaut, `LAYA_TORCH_INDEX_URL` pour `cu130`/`cu132`).

Sans Docker, dans un virtualenv Python 3.11 (mêmes deux étapes que l'image) :

```bash
python3.11 -m venv .laya && . .laya/bin/activate
pip install --no-deps --index-url https://download.pytorch.org/whl/cpu "torch==2.14.0"
pip install -c infra/docker/laya/constraints.txt "laya[serve]==0.3.9"
HF_HOME=$PWD/.laya/models LAYA_MODEL_REVISION=5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b \
  python infra/docker/laya/download-models.py          # une fois (~1,5 Gio)
HF_HOME=$PWD/.laya/models HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 LAYA_MODELS=english,multilingual laya-serve
```

puis `LAYA_BASE_URL=http://localhost:8000` dans `.env` et `npm run dev`.

L'image (`infra/docker/laya/Dockerfile`) : Python 3.11 slim épinglé par digest,
`laya[serve]==0.3.9` + toutes les dépendances épinglées (`constraints.txt`),
PyTorch CPU par défaut (argument `TORCH_INDEX_URL` pour CUDA), utilisateur
10001, compatible système de fichiers en lecture seule, `HEALTHCHECK /health`,
`CMD ["laya-serve"]`, port 8000, aucune clé ni aucun poids intégrés (sauf
`BAKE_MODELS`, §11).

## 10. Déploiement NKP / Helm

Laya est un **Deployment séparé** (pas un sidecar) du chart
`infra/helm/outlook-ai-orchestrator`, désactivé par défaut (`laya.enabled=false`).

```bash
# 1. Image interne
docker build -t registry.internal/ai/laya:0.3.9-oao.1 infra/docker/laya && docker push registry.internal/ai/laya:0.3.9-oao.1
# 2. Clé partagée orchestrateur ↔ Laya
kubectl -n oao create secret generic outlook-ai-laya --from-literal=api-key="$(openssl rand -hex 32)"
# 3. Poids sur le PVC (§11), puis activation en shadow
helm upgrade --install oao infra/helm/outlook-ai-orchestrator -n oao \
  -f infra/helm/outlook-ai-orchestrator/values-nkp.yaml -f my-secrets.yaml \
  --set laya.enabled=true --set laya.mode=shadow
kubectl -n oao rollout status deploy/oao-laya --timeout=15m
```

Rendu : Deployment `oao-laya` (+ init container `models` qui vérifie les poids),
Service ClusterIP `:8000`, PVC `oao-laya-models` (conservé à la désinstallation),
ConfigMap de taxonomie si `laya.taxonomy.existingConfigMap` est vide,
NetworkPolicies (entrée depuis les pods orchestrateur uniquement ; **aucune
sortie** hors mode téléchargement), variables `DECISION_PROVIDER`/`LAYA_*` dans la
ConfigMap de l'orchestrateur, taxonomie et clé montées en fichiers dans les pods
api/worker (`LAYA_API_KEY_FILE`), alertes Prometheus (`OaoLayaCircuitOpen`,
`OaoLayaErrorRateHigh`, `OaoLayaLowConfidenceRateHigh`).

Sécurité du pod : `runAsNonRoot` (10001), `readOnlyRootFilesystem`, pas
d'escalade de privilèges, `capabilities.drop: [ALL]`, `seccompProfile:
RuntimeDefault`, `emptyDir` uniquement sur `/tmp`, poids montés en lecture seule.
Sondes : `startupProbe` `/health` jusqu'à 10 min (chargement des checkpoints),
`readiness` et `liveness` `/health`.

Le chart refuse au rendu : `mode=active` sans `apiKey.existingSecret` ou sans
taxonomie fournie (`existingConfigMap` / `inline`), un tag `latest`,
`strategy=fixed` sans `fixedModel`, `weights.source=pvc` sans persistance.

Valeurs principales : voir `values.yaml` (bloc `laya:`) et le README du chart.
Manifests sans Helm : `npm run k8s:render -- --values my-laya-values.yaml`.

## 11. Fonctionnement hors ligne et stockage des poids

Le serveur d'inférence **ne télécharge jamais** : `HF_HUB_OFFLINE=1` et
`TRANSFORMERS_OFFLINE=1` dans l'image, dans compose et dans le chart
(`laya.offline: true`). Les poids sont présents avant le démarrage, sinon le pod
échoue explicitement (init container, code 3) et l'orchestrateur bascule en
fallback.

Poids épinglés : dépôt `convaiinnovations/laya`, commit
`5e7b2b1b8ca2ecdd3f2322d94069c9b6ce7e844b` (`LAYA_MODEL_REVISION` /
`laya.weights.revision`). Tailles : `english` ≈ 807 Mio, `multilingual` ≈ 647 Mio
(≈ 1,5 Gio pour les deux ; `typed-decisions` ≈ 804 Mio, non utilisé).

Deux stratégies :

**A. PVC interne (défaut Helm)** — `laya.weights.source: pvc`
1. Premier remplissage, au choix :
   - `--set laya.weights.download.enabled=true` (+ `laya.weights.download.hfEndpoint`
     vers un miroir interne) le temps d'un démarrage : l'init container télécharge
     ce qui manque ; la NetworkPolicy ouvre alors DNS + 443 vers
     `egressCidrs` **pour ce pod seulement**. Repasser à `false` ensuite ;
   - ou copier un cache Hugging Face déjà rempli (`/models/huggingface/hub/…`) dans
     le PVC par une opération contrôlée.
2. Le Deployment monte le PVC en lecture seule ; l'init container vérifie la
   présence des checkpoints à chaque démarrage (hors ligne, sans rien écrire).

**B. Image avec poids embarqués** — environnements totalement hermétiques
```bash
docker build --build-arg BAKE_MODELS=english,multilingual \
  --build-arg HF_ENDPOINT=https://hf-mirror.internal \
  -t registry.internal/ai/laya:0.3.9-oao.1-weights infra/docker/laya
```
puis `laya.weights.source: image` (pas de PVC). Image plus lourde (~+1,5 Gio) mais
autonome ; le digest de l'image fige aussi les poids.

Dans les deux cas, `infra/docker/laya/download-models.py` est le seul code qui
télécharge (fichiers limités à ceux que Laya charge, `refs/main` pointé sur le
commit épinglé, patch tokenizer appliqué pendant que le volume est inscriptible).

## 12. Sécurité

- **Aucune donnée ne sort** : Laya tourne dans le cluster / sur le poste ; en
  production il n'a aucune route de sortie (NetworkPolicy `egress: []`).
- **Email = donnée non fiable** : il ne peut modifier ni les questions, ni les
  critères, ni le nom du modèle, ni la configuration, ni la taxonomie — tous
  construits côté serveur (constantes + taxonomie validée). Les choix renvoyés
  sont revalidés contre les options posées ; un choix inconnu est rejeté. Dans
  le prompt narratif, un bloc `### SYSTEM DECISIONS` forgé dans l'email est
  neutralisé.
- **Clé** : `LAYA_API_KEY` lue depuis un fichier monté (`LAYA_API_KEY_FILE`),
  jamais journalisée, jamais renvoyée par `/admin/system` ni `/health` (qui
  n'affichent pas non plus l'URL).
- **Journaux et audit** : ni corps, ni sujet, ni adresse, ni state ; seulement
  type d'erreur, statut HTTP, latence, identifiant de corrélation, hash du state,
  choix, confiances, versions. Vérifié par `npm run smoke:laya` (canaris).
- **Validation stricte** des réponses (zod, taille bornée, redirections refusées,
  corps d'erreur jamais cité).
- **Actions** : `move_to_folder` proposé seulement (`requiresConfirmation`,
  non présélectionné), et jamais pour un email suspect de phishing ; exécution Graph uniquement après validation, et pour un
  identifiant de dossier Graph — un chemin de taxonomie reste une consigne côté
  client.
- Image non-root, lecture seule, dépendances et image de base épinglées.

## 13. Observabilité

Métriques (`/metrics`, labels bornés — identifiants de taxonomie, jamais de contenu) :

| Métrique | Labels |
|---|---|
| `oao_laya_requests_total` | `outcome` (ok, timeout, network, unauthorized, invalid_request, model_error, rate_limited, server, invalid_response, circuit_open, queue_timeout…) |
| `oao_laya_request_duration_seconds` | `outcome` |
| `oao_laya_fallbacks_total` | `reason` (mode active) |
| `oao_laya_low_confidence_total` | `question` |
| `oao_laya_circuit_state` | — (0 fermé, 1 demi-ouvert, 2 ouvert) |
| `oao_laya_shadow_comparisons_total` | `question`, `result` (match, mismatch, unmapped) |
| `oao_laya_decisions_total` | `question`, `choice` |
| `oao_laya_model_calls_saved_total` | `reason` (triage, cache, coalesced, single_folder, other_area, no_folders, area_not_accepted) |

- `/api/v1/health` : check `laya` (présent seulement si activé ; dégradé si Laya
  est injoignable ; le statut global ne se dégrade qu'en mode `active`).
  `/api/v1/ready` **n'en dépend jamais**.
- `/api/v1/admin/system` → `decisioning` : fournisseur, mode, état, circuit,
  stratégie de modèle, checkpoints chargés, versions, seuils, compteurs, taux de
  confiance insuffisante, latence moyenne. Affiché dans le dashboard (page
  Système, carte « Moteur de décision »).
- Audit : bloc `details.decision` (consulté, mode, source, chemin de prompt,
  raison du fallback, état du circuit, comparaison shadow) et, par question,
  choix + confiance + verdict, hash et taille du state, versions — sans contenu.
- Add-in : carte « Décision structurée » (urgence, domaine, dossier, confiance,
  indicateur de confiance insuffisante) ; la **source** n'apparaît qu'en mode
  diagnostic (Paramètres → Diagnostics).

## 14. Évaluation

Voir [`evaluation/laya/README.md`](../evaluation/laya/README.md).

```bash
npm run eval:laya -- --provider mock                     # plomberie
npm run eval:laya -- --dataset evaluation/laya/private/annotated.jsonl
```

Le harnais passe par `EmailDecisionService` (même code qu'en production) et
mesure, par question : exactitude, couverture au-dessus du seuil, exactitude
des décisions acceptées, taux de fallback, confiance moyenne des réponses
justes / fausses, matrice de confusion, balayage de seuils, stabilité quand
l'ordre des options change ; plus l'exactitude du dossier (sachant le domaine
juste) et la latence p50/p95. Le jeu réel reste hors Git
(`evaluation/laya/private/`).

**Procédure d'activation recommandée :**

1. `shadow` (échantillon 100 %) pendant au moins 2 semaines ; suivre
   `oao_laya_shadow_comparisons_total`, `oao_laya_low_confidence_total`, la latence.
2. Annoter un jeu interne représentatif (≥ 300 emails, ≥ 20 par domaine, deux
   annotateurs sur une partie).
3. `npm run eval:laya` ; choisir les seuils sur le balayage ; vérifier la
   stabilité et les confusions entre domaines proches ; ajuster la taxonomie.
4. Mesurer les erreurs **avant** activation ; documenter la décision (seuils,
   version de taxonomie, commit des poids, résultats).
5. `active` sur un périmètre restreint, puis élargir. Le déplacement reste soumis
   à validation humaine dans tous les cas.

## 15. Rollback

| Retour | Action | Effet |
|---|---|---|
| active → shadow | `LAYA_MODE=shadow` (Helm `laya.mode`) | réponses historiques ; cache d'active non réutilisé (empreinte différente) |
| → désactivé | `DECISION_PROVIDER=disabled` (Helm `laya.enabled=false`) | comportement historique **octet pour octet** ; les entrées de cache historiques redeviennent adressées ; aucun redémarrage de Laya nécessaire |
| Nouveau modèle / nouvelles questions | revenir au tag / commit précédent + incrémenter `LAYA_DECISION_VERSION` | invalide le cache des décisions |
| Laya en panne | rien : circuit + fallback automatiques ; alerte `OaoLayaCircuitOpen` | analyses via le LLM |

Le PVC des poids est conservé (`helm.sh/resource-policy: keep`) : le supprimer
explicitement si Laya est abandonné.

## 16. Limites connues

Mesuré le 23/09/2026 dans ce dépôt — bac à sable 4 vCPU sans GPU, laya 0.3.9,
poids `5e7b2b1b`, taxonomie d'exemple, jeu **synthétique** de 24 emails
(`npm run eval:laya`). **Indicatif, pas une mesure de qualité** : 24 emails
fabriqués ne représentent pas le courrier de Northbridge.

- chargement des deux checkpoints : ~13 s ; latence moteur par email (un ou deux
  appels) : p50 ≈ 1,2 s, p95 ≈ 3,2 s ; un seul appel à la fois par pod ;
- résultats avec les seuils par défaut :

  | question | exactitude | couverture ≥ seuil | exactitude acceptée | confiance moy. juste / fausse | stabilité (ordre des options) |
  |---|---:|---:|---:|---|---:|
  | urgency | 41,7 % | 0 % | — | 0,29 / 0,24 | 58 % |
  | businessArea | 58,3 % | 16,7 % | 100 % (4/4) | 0,50 / 0,19 | 58 % |
  | folder (bout en bout) | 19,0 % | 4,8 % | 100 % (1/1) | 0,83 / — | 86 % |
  | replyExpected | 66,7 % | 0 % | — | 0,20 / 0,17 | 75 % |
  | actionRequired | 50,0 % | 0 % | — | 0,26 / 0,20 | 75 % |

  Lecture : seule la confiance du **domaine** sépare nettement les réponses justes
  des fausses ; urgence, réponse attendue et action requise sont proches du hasard
  avec une confiance basse. Le filtre joue son rôle (presque tout repart vers le
  LLM), mais **le gain réel de Laya sur ces questions reste à démontrer** sur des
  données internes — éventuellement avec un modèle fine-tuné (§18). La stabilité
  à 58 % révèle un biais de position des options ;
- réponses erronées observées sur des cas simples (« réponse non requise » pour un
  email qui demande explicitement une confirmation ; domaine qui change quand le
  state change légèrement) : **ne pas activer sans évaluation interne**.

Structurelles :

- **Calibration** : aucune pour `multilingual`, aucune pour 11+ options avec
  `english` (§7). Préférer ≤ 10 options par question.
- **Fenêtre** : 512 tokens (`english`) / 1024 (`multilingual`), dont ~200 pour la
  question et les options : le corps est tronqué (début + fin gardés).
- **Débit** : `laya-serve` sérialise l'inférence (un appel à la fois par pod) ;
  monter `laya.replicaCount` **et** `LAYA_CONCURRENCY` ensemble ; avec un PVC
  ReadWriteOnce, les réplicas doivent partager un nœud (ou poids embarqués / ROX).
- **Détection de langue** heuristique (FR/EN) ; une autre langue part sur
  `multilingual` avec des questions dans la langue du lecteur.
- `laya-serve` n'expose pas de métriques Prometheus : l'observabilité passe par
  l'orchestrateur.
- Seules les questions à choix (`choice`) sont utilisées ; `score` et `noul` ne le
  sont pas. Le checkpoint `typed-decisions` n'est pas utilisé.
- Mode GPU **non testé** ; image CUDA non construite en CI.
- Aucun déploiement NKP réel n'a été effectué depuis ce dépôt : chart rendu,
  linté et validé (kubeconform) uniquement.

## 17. Changer de modèle

1. Choisir le checkpoint (`LAYA_MODEL_STRATEGY` / `LAYA_FIXED_MODEL`, Helm
   `laya.model.*`) et/ou le commit des poids (`LAYA_MODEL_REVISION`,
   `laya.weights.revision`).
2. Mettre à jour `laya.model.checkpoints` si un nouveau checkpoint doit être chargé,
   remplir le PVC (§11) ou reconstruire l'image embarquée.
3. **Incrémenter `LAYA_DECISION_VERSION`** (invalide le cache des décisions).
4. Repasser en `shadow`, relancer `npm run eval:laya` sur le jeu annoté, comparer
   au rapport précédent, puis réactiver.

Changer la version de Laya elle-même : `LAYA_VERSION` / `TORCH_VERSION` dans le
Dockerfile, régénérer `constraints.txt` (§19), nouveau tag d'image
(`0.x.y-oao.N`), mêmes étapes 3–4.

## 18. Activer un modèle fine-tuné

Laya sait charger un checkpoint local (dossier contenant `rl_agent_config.json`,
`model.safetensors`, `tokenizer/`, `encoder/`) ; `laya-serve` 0.3.9 ne connaît
toutefois que trois noms (`english`, `multilingual`, `typed-decisions`) liés au
dépôt `convaiinnovations/laya`. Deux voies :

**A. Miroir interne au même format** (aucun code) — publier le checkpoint
fine-tuné dans un miroir Hugging Face interne sous le même identifiant de dépôt
et le même sous-dossier (p. ex. `multilingual/`), avec un commit dédié ; pointer
`HF_ENDPOINT` et `LAYA_MODEL_REVISION` / `laya.weights.revision` sur ce miroir et
ce commit pour le remplissage du PVC (ou `BAKE_MODELS`). Le serveur le charge
sous le nom `multilingual`.

**B. Image dérivée avec un point d'entrée qui remplace un checkpoint** :

```python
# serve_custom.py — image FROM registry.internal/ai/laya:0.3.9-oao.1
import os, uvicorn
from laya.router import Router
from laya.serve import create_app
router = Router(models={"multilingual": os.environ["LAYA_CUSTOM_MULTILINGUAL"]},  # dossier local
                device=os.environ.get("LAYA_DEVICE") or None)
router.preload(os.environ.get("LAYA_MODELS", "english,multilingual").split(","))
uvicorn.run(create_app(router), host="0.0.0.0", port=int(os.environ.get("LAYA_PORT", "8000")))
```

Dans les deux cas : incrémenter `LAYA_DECISION_VERSION`, repartir en `shadow`,
évaluer sur le jeu annoté (le fine-tuning doit avoir été fait sur des données
distinctes du jeu d'évaluation), vérifier la calibration (écart de confiance
juste/faux, balayage), puis seulement réactiver.

## 19. Version épinglée (0.3.8 → 0.3.9)

La demande initiale visait `laya[serve]==0.3.8`. Cette version **n'est pas publiée
sur PyPI** (versions disponibles au 23/09/2026 : 0.1.0 … 0.3.6, puis 0.3.9).
L'amont décrit 0.3.9 comme une version de packaging sans changement de code ni de
checkpoint par rapport à 0.3.8 ; le contrat HTTP (`/v1/systemone`, `/health`) a
été vérifié contre le paquet 0.3.9 réellement installé. L'image épingle donc
`0.3.9` (`ARG LAYA_VERSION`, surchargeable pour un miroir interne) et le tag
`0.3.9-oao.1`.

Régénérer les contraintes après un changement de version :

```bash
python3.11 -m venv /tmp/v && /tmp/v/bin/pip install --dry-run --ignore-installed \
  --report /tmp/report.json --extra-index-url https://download.pytorch.org/whl/cpu \
  "laya[serve]==<version>" "torch==<version>+cpu"
# puis reporter les versions résolues dans infra/docker/laya/constraints.txt
```

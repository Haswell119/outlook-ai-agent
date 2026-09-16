# Charge IA — comment l'orchestrateur épargne le GPU interne

> Public : équipe infra / IT Northbridge qui dimensionne le nœud GPU, et
> développeurs qui touchent aux chemins IA. Termes techniques laissés en anglais.
> Chiffres de référence : **50 utilisateurs**, modèle interne **Qwen3** servi par
> vLLM sur **2 GPU**.

Le principe directeur : **le meilleur appel au modèle est celui qu'on ne fait
pas**. Tout ce qui peut être décidé par des règles pures, réutilisé depuis un
cache ou calculé la nuit l'est. Le modèle ne voit que ce qui a réellement besoin
de lui, et ne voit du texte que ce qui est strictement nécessaire.

---

## 1. Les sept leviers, du moins cher au plus cher

| # | Levier | Où | Effet |
|---|---|---|---|
| 1 | **Triage heuristique** | `domain/triage.ts` | 40–60 % des emails entrants ne déclenchent **aucun** appel modèle |
| 2 | **Slimming du prompt** | `domain/prompts/clean.ts` | −60 à −90 % de tokens d'entrée sur les fils de discussion |
| 3 | **Cache par hash de contenu** | `analysis_cache` + `services/AiCacheService.ts` | 0 appel pour un contenu déjà analysé (TTL 7 j) |
| 4 | **Coalescing** | `util/coalesce.ts` | Les requêtes identiques simultanées partagent un seul appel |
| 5 | **Précalcul (sync mailbox)** | `workers/mailboxSync.ts` | L'analyse est déjà faite quand l'utilisateur ouvre Outlook |
| 6 | **Routage deux niveaux** | `adapters/llm/queue.ts` | Les tâches structurées vont sur un petit modèle |
| 7 | **Cache d'embeddings** | `embedding_cache` | Ré-indexer une boîte ne ré-embedde jamais le texte inchangé |

Deux garde-fous complètent le dispositif : la **file d'attente** (concurrence
bornée, priorités, équité entre utilisateurs) et le **circuit breaker** (repli
heuristique immédiat quand le modèle est en panne).

---

## 2. Levier 1 — Triage avant tout appel (`TRIAGE_ENABLED`, défaut `true`)

`triageEmail()` classe chaque email entrant à partir de l'expéditeur, du sujet,
du corps et des pièces jointes, **sans aucune I/O** :

| `triage.kind` | Détection | Appel modèle |
|---|---|---|
| `out_of_office` | « Out of office », « Absent du bureau », « Réponse automatique », « De retour le » | non |
| `calendar` | pièce jointe `.ics` / `text/calendar`, sujet `Invitation:` / `Accepted:` / `Réunion annulée`, `BEGIN:VCALENDAR` | non |
| `newsletter` | marqueurs équivalents à `List-Unsubscribe` (« unsubscribe », « se désabonner », « ne plus recevoir », « voir dans le navigateur »…) | non |
| `automatic` | « message généré automatiquement », « ne pas répondre », accusés de réception, NDR | non |
| `notification` | expéditeur `noreply@`, `no-reply@`, `notifications@`, `mailer-daemon@`, sujets `[Jira] …` | non |
| `trivial` | accusé de réception court (« Merci », « Bien reçu », « Thanks », « Noted »), corps vide | non |
| `conversation` | tout le reste | **oui** |

L'ordre des tests compte : une réponse d'absence envoyée depuis `noreply@` est un
`out_of_office`, pas une `notification`.

Pour tout ce qui n'est pas `conversation`, `triageAnalysis()` produit une
`EmailAnalysis` complète et valide : `source: "heuristic"`, `triage` renseigné,
résumé **gabarit FR/EN**, catégorie, actions suggérées (classer / archiver /
rappel de relance), et une **confiance basse mais honnête** (0,45–0,55 : la
classification est fiable, le résumé est un gabarit). Un `AuditEvent` est écrit
comme pour n'importe quelle réponse IA — la traçabilité n'est jamais négociable.

Un email interne dont le pied de page contient « unsubscribe » n'est pas classé
newsletter (`INTERNAL_DOMAINS` protège les collègues).

**Pour désactiver** (par exemple pour mesurer l'écart) : `TRIAGE_ENABLED=false`.
Tous les emails partent alors au modèle.

---

## 3. Levier 2 — Slimming du prompt

`cleanBody()` retire, dans cet ordre : l'historique cité (`On … wrote:`,
`Le … a écrit :`, `-----Original Message-----`, blocs `De :`/`From:`, suites de
`>`), les signatures (formule de politesse seule sur sa ligne, `--`, lignes de
téléphone, « Envoyé de mon iPhone »), les mentions légales de confidentialité,
puis les paramètres de tracking des URL (`utm_*`, `gclid`, `fbclid`…). Le texte
est enfin plafonné à **`LLM_INPUT_MAX_CHARS`** (12 000 par défaut) en gardant
**tête et queue** — la demande réelle est souvent la dernière phrase.

`slimThread()` applique ça à chaque message d'un fil, puis **déduplique les
lignes déjà présentes dans un message plus récent** (une chaîne de réponses
contient N fois le même texte), garde les **`THREAD_MAX_MESSAGES`** (12) plus
récents en entier et résume les autres en un **digest d'une ligne par message**.

Chaque appel écrit ses statistiques dans l'audit
(`details.promptStats = { rawChars, chars, tokens, savedRatio, droppedMessages }`,
estimation `chars / 4`). C'est la métrique à regarder pour savoir si un nouveau
type de contenu échappe au nettoyage.

---

## 4. Leviers 3 et 4 — Cache de contenu et coalescing

**Clé de cache** = SHA-256 de (sujet + corps nettoyé + noms des pièces jointes +
langue + `PROMPT_VERSION`), normalisée (minuscules, accents et espaces
neutralisés). Conséquences utiles :

- le même email ouvert deux fois, ou par deux personnes d'une liste de diffusion,
  ne coûte qu'un appel ;
- une signature ou un historique cité qui change ne casse **pas** la clé (ils
  sont retirés avant le hash) ;
- **changer un prompt invalide le cache** : il suffit de bumper `PROMPT_VERSION`.

Le cache est **cloisonné par utilisateur** (`analysis_cache.user_id` fait partie
de la clé primaire) : jamais une boîte ne lit l'analyse d'une autre.

TTL : `ANALYSIS_CACHE_TTL_HOURS` (168 h = 7 jours). Une réponse **dégradée**
(modèle en panne, repli heuristique) n'est **jamais** mise en cache — sinon une
panne de 30 secondes serait resservie pendant une semaine.

Le **coalescing** (`Coalescer`) fait partager une seule promesse aux requêtes
identiques simultanées : le volet Outlook qui se re-rend, ou six personnes qui
ouvrent le même email diffusé à la même seconde, ne produisent qu'un appel.

Les trois chemins (analyse, synthèse de fil, brouillon) passent par le même
mécanisme ; le brouillon est mis en cache **par intention, ton et instructions**
(cliquer deux fois sur « Accepter » = 1 appel, « Accepter » puis « Refuser » = 2).

**`source` renvoyé au client** : `llm` | `cache` | `precomputed` | `heuristic`.
L'audit porte `details.cached`, `details.cacheSource`, `details.coalesced`.

---

## 5. Levier 5 — Précalcul (`PRECOMPUTE_ENABLED`)

Le worker `mailboxSync` interroge Graph en **delta query** toutes les
`SYNC_INTERVAL_MINUTES` (10), indexe les nouveaux messages, les trie, et analyse
les `conversation` **en priorité basse**. Résultat : `GET /analyze/email/:id`
répond en quelques millisecondes avec `source: "precomputed"`, sans travail GPU
sur le chemin critique.

### Deux modes d'accès

**a) Délégué (`GRAPH_AUTH_MODE=obo`, défaut)** — quand un utilisateur appelle
l'API avec un jeton AAD et que `PRECOMPUTE_ENABLED=true`, le jeton est échangé
On-Behalf-Of et le compte résultant est conservé dans le cache de jetons
msal-node ; son `homeAccountId` est persisté dans `mailbox_sync_state` et le
worker rafraîchit ensuite silencieusement (`acquireTokenSilent`).

> **Limites, assumées.** Le cache msal-node est **en mémoire et non persisté** :
> un redémarrage de pod le perd jusqu'au prochain appel de l'utilisateur. Le
> refresh token sous-jacent expire et peut être révoqué (une personne qui n'ouvre
> pas Outlook pendant des semaines cesse d'être synchronisée). Une politique
> d'accès conditionnel peut refuser le rafraîchissement silencieux. Dans tous ces
> cas la boîte passe en `state: "error"` avec un `lastError` explicite et repart
> toute seule au prochain appel de l'utilisateur. C'est acceptable pour une
> phase pilote, **pas** pour un service garanti.

**b) Permissions applicatives (`GRAPH_AUTH_MODE=app`) — recommandé en production
pour 50 boîtes.** Client credentials avec la permission **applicative**
`Mail.Read`, restreinte aux seules boîtes du projet par une *application access
policy* Exchange :

```powershell
New-ApplicationAccessPolicy `
  -AppId <AAD_CLIENT_ID> `
  -PolicyScopeGroupId oao-synced@northbridge.example `
  -AccessRight RestrictAccess `
  -Description "Outlook AI Orchestrator — lecture des boîtes synchronisées"
Test-ApplicationAccessPolicy -Identity ana@northbridge.example -AppId <AAD_CLIENT_ID>
```

Le worker synchronise alors `SYNC_USERS` (liste d'UPN) ou les membres de
`SYNC_GROUP_ID`, sans dépendre de qui est connecté. Sans cette policy,
`Mail.Read` applicative donne accès à **toutes** les boîtes du tenant : la policy
n'est pas optionnelle.

### Respect du throttling Graph

429 et 503 sont réessayés en honorant `Retry-After`, puis backoff exponentiel
avec jitter ; les requêtes sont groupées par `$batch` (20 par aller-retour) ;
`Prefer: outlook.body-content-type="text"` évite de télécharger puis nettoyer du
HTML (~60 % de charge utile en moins) ; `@odata.nextLink` est suivi jusqu'à
`SYNC_MAX_MESSAGES_PER_RUN` (100), et s'il reste des pages le worker repasse en
15 s au lieu d'attendre l'intervalle complet.

Le jeton delta est stocké par utilisateur (`mailbox_sync_state.delta_token`) : à
chaque passage, Graph ne renvoie que ce qui a changé.

`GET /mailbox/sync` renvoie le `MailboxSyncStatus`; `POST /mailbox/sync` déclenche
une synchronisation pour l'appelant (un admin peut passer `?userId=`).

---

## 6. Brief quotidien — coût marginal

`DailyBriefService` assemble le brief **à partir des analyses déjà calculées** et
de l'index : aucune nouvelle analyse. Le seul appel modèle rédige le titre et les
3–6 puces à partir d'une fiche de faits compacte (~400 tokens d'entrée), et il
est **sauté** si le modèle est indisponible ou le circuit ouvert → `source:
"heuristic"`. Un job planifié à `DAILY_BRIEF_HOUR` (07:00, fuseau `TZ`) le
génère pour chaque boîte synchronisée, en priorité basse, avant l'arrivée des
utilisateurs.

---

## 7. Garde-fous — file d'attente et circuit breaker

Une réplique vLLM sert un nombre borné de séquences concurrentes ; au-delà, la
concurrence n'ajoute pas de débit, elle allonge la latence de tout le monde.

- **`LLM_CONCURRENCY`** (4) appels simultanés maximum, le reste attend.
- **Deux voies de priorité** : `interactive` (quelqu'un attend dans Outlook)
  double systématiquement `background` (worker de précalcul, briefs). Le travail
  de fond ne fait que remplir le GPU inoccupé.
- **Équité entre utilisateurs** : à l'intérieur d'une voie, le prochain appel va
  à l'utilisateur le moins servi du backlog courant (round-robin), puis FIFO.
  Quelqu'un qui ré-indexe dix ans d'archives ne peut pas affamer les 49 autres.
- **`LLM_QUEUE_TIMEOUT_MS`** (30 s) : une requête qui n'obtient pas de place
  échoue en `timeout` — le service renvoie une réponse heuristique plutôt qu'un
  sablier.
- **Circuit breaker** : après `LLM_CIRCUIT_FAILURES` (5) échecs consécutifs, le
  circuit s'ouvre pendant `LLM_CIRCUIT_COOLDOWN_MS` (30 s) et **tout appel échoue
  immédiatement** — les services basculent en heuristiques sans attendre, et le
  modèle a de l'air. Un appel d'essai passe à la fin du cooldown (half-open) ; un
  succès referme le circuit. Une sortie JSON invalide n'ouvre **pas** le circuit :
  le modèle a répondu, il a juste mal répondu.

État exposé dans `SystemStatus.llmQueue` (`GET /api/v1/admin/system`) et en
Prometheus (`oao_llm_queue_depth`, `oao_llm_circuit_open`).

---

## 8. Dimensionnement pour ~50 utilisateurs

### Hypothèses

| Grandeur | Valeur retenue |
|---|---|
| Utilisateurs | 50 |
| Emails reçus / personne / jour ouvré | 80 (soit 4 000 pour l'entreprise) |
| Part triée sans modèle (newsletters, notifications, OOO, accusés) | 50 % |
| Emails réellement ouverts dans le volet IA | ~35 % des `conversation` |
| Taux de cache (mêmes contenus, listes de diffusion, ré-ouvertures) | ~25 % |

### Appels modèle par jour

| Usage | Calcul | Appels/jour |
|---|---|---|
| Analyses précalculées (`conversation` uniquement) | 4 000 × 50 % | **2 000** |
| Analyses à la demande non couvertes par le précalcul / cache | ~5 % de 2 000 | 100 |
| Brouillons de réponse | 50 × 6 | 300 |
| Synthèses de fil | 50 × 2 | 100 |
| Chat / recherche conversationnelle | 50 × 4 | 200 |
| Vérifications compliance (compose, avec destinataires externes) | 50 × 3 | 150 |
| Briefs quotidiens | 50 × 1 | 50 |
| **Total** | | **≈ 2 900 appels/jour** |

Sans les leviers (tout au modèle, prompts bruts, aucun cache) la même activité
demanderait ≈ 4 000 + 850 ≈ **4 850 appels** avec des prompts 3 à 5 fois plus
gros : **c'est un facteur 4 à 6 sur le temps GPU**, pas 40 %.

### Tokens

Avec le slimming, un prompt d'analyse fait typiquement **600–1 500 tokens**
d'entrée et 250–400 de sortie ; une synthèse de fil 1 500–3 000 / 500 ; un brief
400 / 200.

Volume quotidien : ≈ 2 900 appels × ~1 100 tokens d'entrée ≈ **3,2 M tokens
d'entrée** et ≈ 0,9 M de sortie.

### Pourquoi 2 GPU suffisent

Un Qwen3 30B-A3B (MoE, ~3 B paramètres actifs) servi par vLLM sur deux GPU
récents (48–80 Go) tient sans difficulté :

- **préremplissage** de l'ordre de plusieurs milliers de tokens/s ;
- **génération** de l'ordre de quelques centaines de tokens/s agrégés sur les
  séquences concurrentes.

3,2 M tokens d'entrée + 0,9 M de sortie répartis sur une journée représentent
quelques dizaines de minutes de calcul cumulé — l'essentiel de la journée le GPU
est disponible. Le vrai risque n'est pas le volume total mais la **pointe** :
50 personnes qui ouvrent leur boîte entre 8 h et 9 h. C'est exactement ce que
règlent le précalcul (le travail est fait à 7 h, en priorité basse) et la file
avec priorités (les rares appels interactifs de la pointe passent devant).

Un second modèle **petit** (`LLM_FAST_MODEL`, par ex. Qwen3 1.7 B) sur le même
endpoint absorbe classification et vérification de contenu compliance pour une
fraction du coût, et libère le gros modèle pour la prose.

> **Signal de saturation** : surveiller `oao_llm_queue_wait_seconds` (p95) et
> `oao_llm_queue_depth{lane="pending"}`. Si l'attente interactive dépasse
> régulièrement 2 s, augmenter `LLM_CONCURRENCY` **seulement si** le GPU n'est pas
> déjà à 100 % ; sinon ajouter une réplique vLLM ou baisser
> `SYNC_MAX_MESSAGES_PER_RUN`.

---

## 9. Boutons de réglage

| Variable | Défaut | Effet sur la charge |
|---|---|---|
| `TRIAGE_ENABLED` | `true` | `false` → **+100 %** d'appels d'analyse |
| `LLM_INPUT_MAX_CHARS` | `12000` | Plafond du corps envoyé (tête + queue) |
| `THREAD_MAX_MESSAGES` | `12` | Messages gardés en entier dans un fil |
| `ANALYSIS_CACHE_ENABLED` / `ANALYSIS_CACHE_TTL_HOURS` | `true` / `168` | TTL plus long = moins d'appels, réponses plus anciennes |
| `PROMPT_VERSION` | `2026-09-v2` | À bumper à chaque changement de prompt (invalide le cache) |
| `LLM_CONCURRENCY` | `4` | Appels simultanés autorisés sur le GPU |
| `LLM_QUEUE_TIMEOUT_MS` | `30000` | Au-delà, réponse heuristique plutôt qu'attente |
| `LLM_CIRCUIT_FAILURES` / `LLM_CIRCUIT_COOLDOWN_MS` | `5` / `30000` | Rapidité du repli en cas de panne |
| `LLM_FAST_MODEL` | (vide) | Petit modèle pour classification / compliance / extraction |
| `PRECOMPUTE_ENABLED` | `false` | Déplace la charge de la pointe vers la nuit |
| `SYNC_INTERVAL_MINUTES` | `10` | Fraîcheur du précalcul vs. charge de fond |
| `SYNC_MAX_MESSAGES_PER_RUN` | `100` | Plafond de travail de fond par passage |
| `EMBEDDING_BATCH_SIZE` | `64` | Textes par appel `/embeddings` |
| `EMBEDDING_CACHE_ENABLED` | `true` | Ré-indexation quasi gratuite |
| `DAILY_BRIEF_ENABLED` / `DAILY_BRIEF_HOUR` | `true` / `7` | 1 petit appel par utilisateur et par jour |

---

## 10. Vérifier que ça marche

```bash
# Un email deux fois → le second est servi par le cache
curl -s -H 'x-user-email: ana@northbridge.example' -H 'content-type: application/json' \
  -d @email.json localhost:8080/api/v1/analyze/email | jq -r .source   # llm
curl -s -H 'x-user-email: ana@northbridge.example' -H 'content-type: application/json' \
  -d @email.json localhost:8080/api/v1/analyze/email | jq -r .source   # cache

# Une newsletter → aucune sollicitation du modèle
curl -s ... -d @newsletter.json .../analyze/email | jq '{source, triage}'
# { "source": "heuristic", "triage": { "kind": "newsletter", "reason": "body:unsubscribe" } }
```

Métriques Prometheus qui racontent l'histoire :

```promql
# Appels modèle réellement évités, par raison
sum by (reason) (oao_model_calls_saved_total)

# Part des emails triés sans modèle
sum(oao_triage_total{skipped="true"}) / sum(oao_triage_total)

# Taux de succès du cache d'analyses
sum(oao_cache_events_total{cache="analysis",result="hit"})
  / sum(oao_cache_events_total{cache="analysis"})

# Appels modèle par requête HTTP IA (le ratio à surveiller dans le temps)
sum(rate(oao_llm_calls_total{outcome="ok"}[1h]))
  / sum(rate(oao_http_requests_total{route=~"/api/v1/(analyze|draft|chat).*"}[1h]))

# Attente en file, par voie
histogram_quantile(0.95, sum by (le, priority) (rate(oao_llm_queue_wait_seconds_bucket[5m])))
```

Et dans l'audit, chaque ligne porte `details.analysisSource`, `details.cached`,
`details.coalesced`, `details.triage.kind` et `details.promptStats` : l'export CSV
(`GET /api/v1/audit/export`) permet de calculer a posteriori le coût réel d'une
semaine et de justifier le dimensionnement.

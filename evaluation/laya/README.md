# Évaluation des décisions structurées (Laya)

Ce dossier contient le **harnais d'évaluation** des décisions prises par le
moteur local Laya (urgence, domaine métier, dossier, réponse attendue, action
requise) et un **jeu d'exemple synthétique**. Il ne contient, et ne doit jamais
contenir, d'emails réels.

| Fichier | Rôle | Dans Git |
|---|---|---|
| `example-dataset.jsonl` | 24 emails **synthétiques** FR/EN annotés (domaines `.example`) : vérifie la plomberie, ne mesure pas la qualité | oui |
| `private/` | vos jeux annotés réels | **non** (`.gitignore`) |
| `results/` | rapports générés (`.md` + `.json`) | **non** (`.gitignore`) |

## Lancer

```bash
# Plomberie seule, sans moteur (fournisseur mock déterministe)
npm run eval:laya -- --provider mock

# Contre un Laya réel (docker compose --profile laya up, poids téléchargés)
npm run eval:laya

# Sur votre jeu annoté, seuils candidats, sans les permutations (3x moins d'appels)
npm run eval:laya -- --dataset evaluation/laya/private/annotated.jsonl \
  --min-confidence 0.8 --folder-min-confidence 0.85 --no-permutations
```

Le harnais passe par le **même code que la production** (`EmailDecisionService`) :
même state compact, mêmes questions (taxonomie `LAYA_TAXONOMY_FILE`), même
hiérarchie (domaine puis dossier), même politique de confiance, même routage
de modèle (`LAYA_MODEL_STRATEGY`). Il lit la configuration comme le serveur
(environnement, puis `apps/orchestrator/.env`, puis `.env` racine).

Les rapports ne contiennent que les identifiants, les annotations et les
réponses du moteur — jamais le texte des emails.

## Format du jeu (JSON Lines)

Une ligne par email :

```json
{"id":"ops-0042","readerLanguage":"fr",
 "email":{"subject":"…","from":{"address":"…"},"to":[{"address":"…"}],"body":"…","receivedAt":"2026-09-21T08:15:00Z","attachments":[{"name":"x.pdf"}]},
 "expected":{"urgency":"high","businessArea":"operations","folder":"nav","replyExpected":true,"actionRequired":true}}
```

- `expected` : toutes les clés sont facultatives ; une question non annotée est
  simplement exclue de ses métriques.
- `businessArea` / `folder` : identifiants de **votre** taxonomie (le dossier doit
  appartenir au domaine). `other` sans dossier = aucun déplacement attendu.
- `urgency` : `low` · `normal` · `high` · `critical`.

## Constituer un jeu réel (à garder hors Git)

1. Extraire un échantillon **représentatif** (plusieurs semaines, toutes les
   boîtes concernées, les deux langues, les cas faciles *et* ambigus). Viser au
   moins 300 emails, et au moins 20 par domaine.
2. Faire annoter par les personnes qui classent réellement ces emails, idéalement
   deux annotateurs sur une partie pour mesurer leur accord : un moteur ne fera
   pas mieux que l'accord humain.
3. Stocker le fichier sous `evaluation/laya/private/` sur un poste ou un partage
   autorisé à détenir ces données (mêmes règles que les emails eux-mêmes), et le
   supprimer une fois l'évaluation archivée.

## Lire le rapport

| Métrique | Sens |
|---|---|
| **accuracy** | réponse du moteur (argmax) = annotation, sur tous les emails annotés (pas de réponse = faux) |
| **coverage** | part des emails dont la réponse passe le seuil — ce que le mode actif utiliserait |
| **accuracy when accepted** | exactitude sur cette part couverte : **le chiffre qui compte pour le mode actif** |
| **fallback** | 1 − coverage : part renvoyée au LLM (ou aux règles) |
| **mean conf. correct / incorrect** | un écart net = le seuil sépare bien ; aucun écart = la confiance n'est pas exploitable pour cette question |
| **stability** | part des emails dont la réponse ne change pas quand les options sont présentées dans un autre ordre (biais de position) |
| **folder given a correct, accepted area** | dossier juste parmi les emails dont le domaine était juste et accepté |
| **latency p50 / p95** | temps moteur par email (un ou deux appels) |
| **threshold sweep** | couverture → exactitude pour plusieurs seuils : c'est là qu'on choisit `LAYA_MIN_CONFIDENCE` et `LAYA_FOLDER_MIN_CONFIDENCE` |
| **confusion matrices** | quelles confusions (domaines proches, urgences voisines) |

## Précautions

- La confiance de Laya est une **certitude du modèle sur les options proposées**
  (entropie normalisée), pas une probabilité d'avoir raison : une confiance élevée
  peut être fausse, surtout hors distribution (autre langue, autre jargon).
- Les chiffres ne se transfèrent pas : ils valent pour ce jeu, cette taxonomie,
  ces seuils et cette version de modèle. Réévaluer à chaque changement.
- Le jeu synthétique ne vérifie que la plomberie. La décision de passer en mode
  actif se prend sur un jeu **réel, représentatif et annoté**, après une période
  en mode shadow (voir `docs/LAYA.md`), et reste soumise à validation humaine :
  aucune action n'est jamais exécutée sans l'accord de l'utilisateur.

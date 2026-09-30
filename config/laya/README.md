# Taxonomie Laya locale : vos dossiers

Laya choisit le dossier d'un email **parmi ceux d'une taxonomie** : un fichier
JSON qui liste vos domaines et vos dossiers Outlook, chacun avec une courte
description. Le complément ne lit pas les dossiers de la boîte : sans Microsoft
Graph, Office.js n'expose aucune liste de dossiers, et EWS est bloqué dans
Exchange Online à partir d'octobre 2026. Sans fichier, c'est la taxonomie
d'**exemple** (dossiers fictifs) qui est utilisée.

Ce dossier est monté en lecture seule dans les conteneurs `orchestrator` et
`worker` (`/app/config/laya`), sans reconstruire l'image.

## Mise en place

1. Partir de l'exemple :
   `apps/orchestrator/config/laya-taxonomy.example.json` → `config/laya/taxonomy.json`,
   puis y mettre vos domaines et vos dossiers.
2. Dans `.env` : `LAYA_TAXONOMY_FILE=config/laya/taxonomy.json`. Un chemin
   relatif part de la racine du repo (`/app` dans l'image) : la même valeur sert
   au conteneur, à `npm run dev`, à `npm run check:laya` et à `npm run eval:laya`.
3. Appliquer :
   - après avoir modifié `.env` : `docker compose --profile laya up -d orchestrator`
     (recrée le conteneur) ;
   - après avoir seulement modifié le fichier : `docker compose restart orchestrator`.
4. Vérifier :
   - `npm run check:laya` pose une vraie question avec vos options ;
   - au démarrage, le log `structured decisions enabled` indique la version et le
     hash de la taxonomie ;
   - un fichier invalide empêche le démarrage et affiche la liste des erreurs.

## Écrire une bonne taxonomie

- `outlookFolder` est le chemin de votre dossier tel qu'Outlook l'affiche
  (`Clients/Contrats`) : c'est ce que le volet proposera. Le déplacement reste une
  **proposition** que vous validez, puis que vous faites vous-même sans Graph.
- Laya décide à partir des **descriptions**. Écrivez ce qui arrive dans chaque
  dossier, avec des mots concrets : expéditeurs types, sujets, types de documents.
- Les deux niveaux sont hiérarchiques : Laya choisit d'abord le domaine, puis le
  dossier dans ce domaine.
- Pour chaque question (domaines, puis dossiers d'un domaine), restez à 10
  options au plus : au-delà, la confiance du moteur n'est plus calibrée.
- Le domaine `other` est obligatoire et sans dossier (aucun déplacement proposé).
- Règles complètes, validées au démarrage : [`docs/LAYA.md`](../../docs/LAYA.md) §6.

Les `*.json` de ce dossier sont ignorés par Git, car ils décrivent votre boîte
(voir `.gitignore`).

# Contribuer — Outlook AI Orchestrator

FR/EN — le code et les identifiants restent en anglais, la documentation et
les commentaires métier peuvent être en français.

## Branches

- `main` — toujours déployable.
- `feature/<sujet-court>` — nouvelle fonctionnalité.
- `fix/<sujet-court>` — correction de bug.
- `chore/<sujet-court>` — infra, CI, dépendances, docs.

Une PR par sujet, base à jour avec `main` avant de merger.

## Convention de commit

[Conventional Commits](https://www.conventionalcommits.org/) :

```
<type>(<scope>): <résumé au présent, impératif>

[corps optionnel]
```

Types : `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`.
Scope conseillé : `orchestrator`, `addin`, `admin`, `shared`, `infra`,
`docs`. Exemples :

```
feat(orchestrator): add compliance escalation decision endpoint
fix(addin): draft reply chip does not prefill subject
docs(security): clarify Graph scope justification for Tasks.ReadWrite
```

## Definition of Done

Une fonctionnalité ou un correctif n'est considéré "terminé" que si :

- [ ] **Tests ≥ 70 %** de couverture sur les services critiques
      (`apps/orchestrator/src/domain/*`, `apps/orchestrator/src/services/*` —
      risque, conformité, automatisation, audit).
- [ ] **Aucun secret en clair** dans le code, les migrations, les fichiers de
      config ou les commits (`.env` réel jamais commité — seul
      `.env.example` l'est ; voir la vérification `secret-scan` de la CI).
- [ ] **Toute action IA est auditée** : aucun chemin de code ne doit pouvoir
      produire une suggestion, une exécution d'action ou une décision de
      conformité sans écrire l'`AuditEvent` correspondant (non-négociable,
      voir `docs/ARCHITECTURE.md` §4 et `docs/SECURITY.md`).
- [ ] **Documentation à jour** : tout changement de contrat (`@oao/shared`),
      d'endpoint, de variable d'environnement ou de comportement de repli met
      à jour `docs/API.md`, `docs/ACTIONS.md`, `.env.example` et/ou
      `docs/OPERATIONS.md` en conséquence, dans le même PR.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` et `pnpm build` passent
      localement et en CI pour les packages touchés.
- [ ] Toute action à risque `medium`/`high` reste **human-in-the-loop** — pas
      d'exécution automatique ajoutée sans validation utilisateur explicite.

## Avant d'ouvrir une PR

```bash
pnpm --filter @oao/shared build
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Changements d'infrastructure

Périmètre concerné : `infra/**`, `docker-compose*.yml`, `.github/**`,
`scripts/**`, `.env.example`, `docs/**`.

Avant tout : **le code est la source de vérité de la configuration.** Toute
variable ajoutée à `apps/orchestrator/src/config.ts` ou à
`apps/admin/src/env.ts` doit être propagée, dans le même commit, à
`.env.example`, au ConfigMap du chart (`oao.config.data` dans `_helpers.tpl`)
avec sa value documentée, aux `docker-compose*.yml` concernés et au tableau
§8 de `docs/ARCHITECTURE.md`. Une variable secrète passe par le template
Secret (et le montage `<NOM>_FILE`), jamais par le ConfigMap.

```bash
# Chart Helm (source de vérité du déploiement)
helm lint infra/helm/outlook-ai-orchestrator
helm lint infra/helm/outlook-ai-orchestrator -f infra/helm/outlook-ai-orchestrator/values-nkp.yaml
helm template oao infra/helm/outlook-ai-orchestrator -n oao | kubeconform -strict -summary -ignore-missing-schemas -

# Manifests générés (ne jamais les éditer à la main)
pnpm k8s:render

# Parité configuration code <-> .env.example / ConfigMap
grep -oE '^    [A-Z][A-Z0-9_]+:' apps/orchestrator/src/config.ts | tr -d ' :' | sort > /tmp/code.txt
helm template oao infra/helm/outlook-ai-orchestrator -n oao -s templates/configmap.yaml \
  | grep -oE '^  [A-Z][A-Z0-9_]+:' | tr -d ' :' | sort > /tmp/chart.txt
comm -23 /tmp/code.txt /tmp/chart.txt   # dans le code, absent du ConfigMap (secrets et ROLE/PORT exceptés)
comm -13 /tmp/code.txt /tmp/chart.txt   # dans le ConfigMap, inconnu du schéma -> variable morte

# Scripts multi-OS
node --check scripts/*.mjs scripts/lib/*.mjs
node scripts/smoke.mjs --help

# Compose et images
docker compose config -q
docker compose -f docker-compose.prod.yml config -q
docker build -f infra/docker/orchestrator.Dockerfile -t oao/orchestrator:dev .
```

Règles :

- **Le chart Helm est la source unique de vérité** du déploiement.
  `infra/k8s/rendered/` est généré par `pnpm k8s:render` : corriger le chart,
  jamais la sortie.
- **`Chart.yaml: appVersion` doit rester égal à `package.json: version`** — la
  CI le vérifie.
- **Pas de bash dans l'outillage** : tout script développeur est un module
  Node ESM dans `scripts/`, exposé par un alias `pnpm`, et doit fonctionner
  sur Windows, macOS et Linux (la CI l'exécute sur les trois). Pas de `curl`,
  pas de `sleep`, pas de chemin POSIX en dur.
- **Jamais de secret**, même d'exemple réaliste : les valeurs de démonstration
  sont vides ou explicitement des placeholders. Organisation fictive
  « Northbridge Capital », hôtes en `*.northbridge.example`.
- **Toute nouvelle dépendance réseau sortante** d'un composant doit être
  ajoutée aux NetworkPolicies du chart (default-deny) et documentée dans
  `docs/SECURITY.md` §9.
- **Toute nouvelle variable d'environnement** apparaît dans `.env.example`,
  dans `templates/_helpers.tpl` (`oao.config.data`) et dans `values.yaml`.

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

Pour les changements touchant l'infra (`infra/`, `docker-compose.yml`,
`.github/workflows/`) : valider les Dockerfiles/YAML localement (`bash -n`
sur les scripts, `docker build` sur les Dockerfiles modifiés, `kubectl
kustomize infra/k8s` si `kubectl` est disponible).

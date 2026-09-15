# `typings/` — React type-reference shims

`next/dist/types.d.ts` carries `/// <reference types="react/experimental" />` and
`/// <reference types="react-dom/experimental" />`. TypeScript resolves a type
reference directive as a *directory* under one of the `typeRoots`, so
`@types/react/experimental.d.ts` (a file) never matches and the lookup falls back
to walking `node_modules` from Next's own folder. In this pnpm workspace that
fallback lands on the copy of `@types/react@18` hoisted for `@oao/addin`
(React 18 + Fluent UI), which loads a second, incompatible React type tree and
makes every JSX element in this app fail to typecheck.

These two empty declaration packages give the directives something to resolve to
inside `@oao/admin`, so only `@types/react@19` is ever loaded. Nothing else
depends on them — delete them the day the add-in moves to React 19.

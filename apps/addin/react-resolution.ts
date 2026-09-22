/**
 * Single-React resolution for `@oao/addin`.
 *
 * The add-in runs React 18 (Fluent UI v9 and `@types/react@18`); the admin
 * dashboard runs React 19 (Next 15). npm workspaces hoist one of the two to the
 * repository-root `node_modules` and nest the other under the package that
 * asked for it — which one wins is an npm implementation detail, and packages
 * that live at the root (Fluent UI, @testing-library) would otherwise resolve
 * the *hoisted* copy while the task pane resolves its own. Two Reacts in one
 * tree means "Cannot read properties of null (reading 'useState')".
 *
 * Resolving from this package's own manifest always finds the React that
 * `apps/addin/package.json` depends on, wherever npm decided to put it. The
 * result is fed to Vite/Vitest as both an alias (applies to dependencies, even
 * externalised ones) and a dedupe list (applies to everything Vite bundles).
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require_ = createRequire(resolve(__dirname, "package.json"));
const packageDir = (name: string): string => dirname(require_.resolve(`${name}/package.json`));

/**
 * `react` / `react-dom` pinned to this package's copies. String aliases also
 * cover the deep entry points (`react/jsx-runtime`, `react-dom/client`, …).
 */
export const reactAlias: Record<string, string> = {
  react: packageDir("react"),
  "react-dom": packageDir("react-dom"),
};

/** Bare specifiers Vite must never resolve twice. */
export const reactDedupe = ["react", "react-dom"];

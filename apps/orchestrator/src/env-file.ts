/**
 * Loads `.env` files into `process.env` at boot, dependency-free.
 *
 * Precedence (highest first): variables already in the environment (shell,
 * Docker, Kubernetes) > `apps/orchestrator/.env` > repository-root `.env`.
 * Existing variables are never overwritten, so containers and CI stay
 * authoritative. Skipped under `NODE_ENV=test` and when `OAO_SKIP_ENV_FILE=1`.
 *
 * Why: developers configure everything in the single root `.env` (documented
 * in docs/SETUP.md) and `npm run dev` must see the same values as `npm run check:llm`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ and dist/ are both one level below apps/orchestrator.
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

/** Minimal dotenv parser: KEY=value, optional `export`, quotes, `#` comments. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, "\n");
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

/** Candidate files, highest precedence first (`OAO_ENV_FILE` = explicit extra file). */
export function candidateEnvFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.OAO_ENV_FILE?.trim();
  return [...(explicit ? [path.resolve(explicit)] : []), path.join(packageRoot, ".env"), path.join(repoRoot, ".env")];
}

/** Applies the files in order; returns the files that were actually loaded. */
export function loadEnvFiles(files: string[] = candidateEnvFiles(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV === "test" || env.OAO_SKIP_ENV_FILE === "1") return [];
  const loaded: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const parsed = parseEnvFile(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined || env[key] === "") env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}

export const LOADED_ENV_FILES = loadEnvFiles();

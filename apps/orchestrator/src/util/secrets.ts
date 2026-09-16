import { readFileSync } from "node:fs";

/**
 * Kubernetes / NKP mounted-secret support: for every `FOO` we also accept
 * `FOO_FILE=/run/secrets/foo`, read once at boot. The file content wins over an
 * empty `FOO` and loses against an explicitly set, non-empty `FOO` (so an
 * operator can always override a mounted file from the environment).
 *
 * Pure except for `readFileSync` — inject `read` in tests.
 */
export interface ResolveSecretsResult {
  env: NodeJS.ProcessEnv;
  /** Names resolved from a file (for the startup banner; values never logged). */
  fromFiles: string[];
  /** `*_FILE` variables that could not be read (fatal: reported by loadConfig). */
  errors: string[];
}

export function resolveSecretFiles(env: NodeJS.ProcessEnv, read: (p: string) => string = (p) => readFileSync(p, "utf8")): ResolveSecretsResult {
  const out: NodeJS.ProcessEnv = { ...env };
  const fromFiles: string[] = [];
  const errors: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.endsWith("_FILE") || key === "_FILE") continue;
    const target = key.slice(0, -"_FILE".length);
    if (!target) continue;
    const path = (value ?? "").trim();
    if (path === "") continue;
    const existing = (env[target] ?? "").trim();
    if (existing !== "") continue; // explicit env wins
    try {
      // Trailing newlines are the classic cause of "invalid credentials" with mounted secrets.
      out[target] = read(path).replace(/\r?\n+$/, "");
      fromFiles.push(target);
    } catch (e) {
      errors.push(`${key}: cannot read ${path} (${(e as Error).message})`);
    }
  }
  return { env: out, fromFiles, errors };
}

/** Keys whose value must never be printed or logged. */
export const SECRET_KEYS = new Set([
  "LLM_API_KEY",
  "AAD_CLIENT_SECRET",
  "ADMIN_API_TOKEN",
  "METRICS_TOKEN",
  "DATABASE_URL",
  "NOTIFY_WEBHOOK_URL",
]);

/** `postgres://user:pw@host:5432/db` → `postgres://user:***@host:5432/db`. */
export function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):([^@]*)@/, "://$1:***@");
}

/** Value safe to print in the startup banner. */
export function redactValue(key: string, value: unknown): unknown {
  if (value === undefined || value === "") return value;
  if (key === "DATABASE_URL") return redactUrl(String(value));
  if (key === "NOTIFY_WEBHOOK_URL") return String(value).replace(/\?.*$/, "?***");
  if (SECRET_KEYS.has(key)) return "***";
  return value;
}

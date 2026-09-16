/**
 * Startup environment validation for `@oao/admin`.
 *
 * Imported by `src/auth.ts`, `src/middleware.ts` and `src/lib/api.ts`, i.e. on
 * every code path that reaches the server, so an incomplete configuration fails
 * fast and loudly instead of producing a half-working dashboard.
 *
 * Deliberately free of `server-only` and of any Node built-in: the middleware
 * runs on the edge runtime and imports this module too.
 */
import { z } from "zod";

const booleanish = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === "true" || v === "1");

const trimmed = z
  .string()
  .optional()
  .transform((v) => {
    const s = v?.trim();
    return s && s.length > 0 ? s : undefined;
  });

const emailList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );

/** Dev-only placeholder: `AUTH_SECRET` is never used in `token` mode. */
export const TOKEN_MODE_SECRET_PLACEHOLDER = "oao-admin-token-mode-no-session-secret";

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /* --- Orchestrator ------------------------------------------------------ */
    ORCHESTRATOR_URL: z
      .string()
      .default("http://localhost:8080")
      .transform((v) => v.replace(/\/+$/, ""))
      .refine((v) => /^https?:\/\//.test(v), "ORCHESTRATOR_URL must be an http(s) URL"),
    ADMIN_API_TOKEN: trimmed,
    ADMIN_MOCK: booleanish,

    /* --- Presentation ------------------------------------------------------ */
    ADMIN_DEFAULT_LANGUAGE: z.enum(["en", "fr"]).default("en"),
    ADMIN_TENANT_NAME: z.string().min(1).default("Northbridge Capital"),
    /** IANA timezone used to render every date/time. */
    ADMIN_TZ: z.string().min(1).default("Europe/Zurich"),

    /* --- Authentication ---------------------------------------------------- */
    ADMIN_AUTH_MODE: z.enum(["aad", "token"]).default("token"),
    AUTH_SECRET: trimmed,
    AUTH_URL: trimmed,
    AUTH_MICROSOFT_ENTRA_ID_ID: trimmed,
    AUTH_MICROSOFT_ENTRA_ID_SECRET: trimmed,
    /** e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
    AUTH_MICROSOFT_ENTRA_ID_ISSUER: trimmed,
    /** Application (client) id of the orchestrator API app registration. */
    ORCHESTRATOR_API_CLIENT_ID: trimmed,
    /** Full scope override; defaults to `api://{ORCHESTRATOR_API_CLIENT_ID}/access_as_user`. */
    ORCHESTRATOR_API_SCOPE: trimmed,
    /** JWT session lifetime in seconds. */
    ADMIN_SESSION_MAX_AGE: z.coerce.number().int().min(300).max(86_400).default(3_600),

    /* --- Roles ------------------------------------------------------------- */
    ADMIN_EMAILS: emailList,
    COMPLIANCE_EMAILS: emailList,
    /** `token` mode identity (mirrors the orchestrator's dev headers). */
    ADMIN_DEV_EMAIL: z.string().default("admin@northbridge.example"),
    ADMIN_DEV_NAME: z.string().default("Dashboard Operator"),
    ADMIN_DEV_ROLES: z.string().default("admin"),
  })
  .superRefine((env, ctx) => {
    if (env.ADMIN_AUTH_MODE !== "aad") return;
    const required = [
      "AUTH_SECRET",
      "AUTH_MICROSOFT_ENTRA_ID_ID",
      "AUTH_MICROSOFT_ENTRA_ID_SECRET",
      "AUTH_MICROSOFT_ENTRA_ID_ISSUER",
    ] as const;
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when ADMIN_AUTH_MODE=aad`,
        });
      }
    }
    if (!env.ORCHESTRATOR_API_CLIENT_ID && !env.ORCHESTRATOR_API_SCOPE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ORCHESTRATOR_API_CLIENT_ID"],
        message:
          "ORCHESTRATOR_API_CLIENT_ID (or ORCHESTRATOR_API_SCOPE) is required when ADMIN_AUTH_MODE=aad",
      });
    }
    if (env.AUTH_SECRET === TOKEN_MODE_SECRET_PLACEHOLDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_SECRET"],
        message: "AUTH_SECRET must be a real secret when ADMIN_AUTH_MODE=aad",
      });
    }
  });

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AdminEnv extends RawEnv {
  /** Scope requested so the session carries an access token for the orchestrator. */
  apiScope?: string;
  isProduction: boolean;
  /**
   * True when the configuration would serve real data with no sign-in at all.
   *
   * `ADMIN_AUTH_MODE=token` is the development identity: it hands out
   * `ADMIN_DEV_ROLES` (default `admin`) to whoever opens the page, with no
   * credential of any kind. That is fine locally and in the demo, and a
   * catastrophe in production — the dashboard exposes the audit trail of every
   * mailbox and the Policy Center. The orchestrator already refuses
   * `AUTH_MODE=dev` when `NODE_ENV=production`; this is the same rule for the
   * dashboard, enforced at request time (see `middleware.ts` / `session.ts`)
   * rather than at parse time so that `next build`, which runs with
   * `NODE_ENV=production`, is not affected.
   */
  insecureAuthMode: boolean;
}

/**
 * Parses `source` (defaults to `process.env`). Exported for the tests so the
 * schema can be exercised without touching the ambient environment.
 */
export function parseEnv(source: Record<string, string | undefined>): AdminEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`[@oao/admin] invalid environment configuration:\n${detail}`);
  }
  const env = parsed.data;
  const apiScope =
    env.ORCHESTRATOR_API_SCOPE ??
    (env.ORCHESTRATOR_API_CLIENT_ID
      ? `api://${env.ORCHESTRATOR_API_CLIENT_ID}/access_as_user`
      : undefined);
  const isProduction = env.NODE_ENV === "production";
  // `ADMIN_MOCK` serves the deterministic demo dataset and never reaches the
  // orchestrator, so an unauthenticated demo build stays allowed.
  const insecureAuthMode = isProduction && env.ADMIN_AUTH_MODE === "token" && !env.ADMIN_MOCK;
  return { ...env, apiScope, isProduction, insecureAuthMode };
}

let cached: AdminEnv | undefined;

/** Validated environment, parsed once per process. */
export function env(): AdminEnv {
  if (!cached) {
    cached = parseEnv({
      ...process.env,
      // `token` mode never issues an Auth.js session, so a secret is pointless.
      AUTH_SECRET:
        process.env.AUTH_SECRET ??
        (process.env.ADMIN_AUTH_MODE === "aad" ? undefined : TOKEN_MODE_SECRET_PLACEHOLDER),
    } as Record<string, string | undefined>);
  }
  return cached;
}

/** Test seam: forget the memoised value. */
export function resetEnvCache(): void {
  cached = undefined;
}

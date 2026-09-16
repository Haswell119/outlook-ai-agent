import { z } from "zod";
import { redactValue, resolveSecretFiles } from "./util/secrets.js";

/**
 * Environment configuration, validated once at startup (ARCHITECTURE.md §8).
 * Every variable has a safe default so that `LLM_PROVIDER=mock DATABASE_URL=memory`
 * runs without any external dependency.
 *
 * Two production conveniences:
 *  - any `FOO_FILE=/run/secrets/foo` is read at boot and fills `FOO` (K8s/NKP secrets),
 *  - `loadConfig` fails fast with the complete list of problems, never the first one only.
 */
const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const csv = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? def
        : v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );

const int = (def: number) => z.coerce.number().int().default(def);
const optStr = z.string().optional().transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Process role: API only, worker only, or both in a single process. */
    ROLE: z.enum(["api", "worker", "all"]).default("api"),
    PORT: int(8080),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
    /** Display name of the organisation, surfaced in FeatureFlags.organizationName. */
    ORGANIZATION_NAME: z.string().default("Northbridge Capital"),

    /* ------------------------------- model ------------------------------- */
    LLM_PROVIDER: z.enum(["openai-compatible", "mock"]).default("openai-compatible"),
    LLM_BASE_URL: z.string().default("http://localhost:8000/v1"),
    LLM_API_KEY: optStr,
    LLM_MODEL: z.string().default("qwen3-30b-a3b"),
    /** Smaller/faster model for triage-assist, classification, phishing & compliance content, extraction. */
    LLM_FAST_MODEL: optStr,
    LLM_TIMEOUT_MS: int(60000),
    LLM_MAX_TOKENS: int(2048),
    LLM_JSON_MODE: z.enum(["auto", "response_format", "prompt"]).default("auto"),
    EMBEDDINGS_ENABLED: bool(true),
    EMBEDDING_MODEL: z.string().default("bge-m3"),
    EMBEDDING_DIMENSIONS: int(1024),
    /** Texts per /embeddings call. */
    EMBEDDING_BATCH_SIZE: int(64),

    /* --------------------------- AI-load control -------------------------- */
    /** Heuristic triage before any model call (newsletters, notifications, OOO…). */
    TRIAGE_ENABLED: bool(true),
    /** Content-hash cache for analyses / syntheses / drafts. */
    ANALYSIS_CACHE_ENABLED: bool(true),
    ANALYSIS_CACHE_TTL_HOURS: int(168),
    /** Cache of embedding vectors keyed by (model, chunk sha256). */
    EMBEDDING_CACHE_ENABLED: bool(true),
    EMBEDDING_CACHE_TTL_DAYS: int(365),
    /** Hard cap on the body text sent to the model (head + tail kept). */
    LLM_INPUT_MAX_CHARS: int(12000),
    /** Most recent messages kept verbatim in a thread prompt (older ones digested). */
    THREAD_MAX_MESSAGES: int(12),
    /** Bumped whenever a prompt changes: part of every cache key. */
    PROMPT_VERSION: z.string().default("2026-09-v2"),
    /** Global in-flight model calls. */
    LLM_CONCURRENCY: int(4),
    /** Max time a queued request waits for a slot before being treated as unavailable. */
    LLM_QUEUE_TIMEOUT_MS: int(30000),
    /** Consecutive failures that open the circuit. */
    LLM_CIRCUIT_FAILURES: int(5),
    LLM_CIRCUIT_COOLDOWN_MS: int(30000),

    /* ------------------------------ database ------------------------------ */
    DATABASE_URL: z.string().default("postgres://oao:oao@localhost:5432/oao"),
    DB_AUTO_MIGRATE: bool(true),
    DB_POOL_MAX: int(10),
    DB_POOL_MIN: int(0),
    DB_STATEMENT_TIMEOUT_MS: int(15000),
    DB_IDLE_TIMEOUT_MS: int(30000),
    DB_CONNECTION_TIMEOUT_MS: int(5000),
    DEMO_SEED: bool(true),

    /* -------------------------------- auth -------------------------------- */
    AUTH_MODE: z.enum(["dev", "aad"]).default("dev"),
    AAD_TENANT_ID: optStr,
    AAD_CLIENT_ID: optStr,
    AAD_CLIENT_SECRET: optStr,
    /** Extra tenants accepted besides AAD_TENANT_ID (guest / multi-tenant scenarios). */
    AAD_ALLOWED_TENANTS: csv([]),
    /** When set (e.g. `access_as_user`), tokens must carry it in `scp` or in `roles`. */
    AAD_REQUIRE_SCOPE: optStr,
    AAD_CLOCK_SKEW_SECONDS: int(60),
    ADMIN_EMAILS: csv(["admin@northbridge.example"]),
    COMPLIANCE_EMAILS: csv(["compliance@northbridge.example"]),
    ADMIN_API_TOKEN: z.string().default("change-me"),

    /* -------------------------------- graph ------------------------------- */
    GRAPH_ENABLED: bool(false),
    /** `obo`: per-user delegated tokens (default). `app`: client credentials + application access policy. */
    GRAPH_AUTH_MODE: z.enum(["obo", "app"]).default("obo"),

    /* --------------------------- precomputation --------------------------- */
    PRECOMPUTE_ENABLED: bool(false),
    WORKERS_ENABLED: bool(true),
    SYNC_INTERVAL_MINUTES: int(10),
    /** Mailboxes synced in GRAPH_AUTH_MODE=app (UPNs). */
    SYNC_USERS: csv([]),
    /** AAD group whose members are synced (expanded via Graph) — alternative to SYNC_USERS. */
    SYNC_GROUP_ID: optStr,
    SYNC_MAX_MESSAGES_PER_RUN: int(100),
    DAILY_BRIEF_ENABLED: bool(true),
    DAILY_BRIEF_HOUR: int(7),
    /** Timezone used by the daily-brief schedule and brief dates. */
    TZ: z.string().default("UTC"),

    /* ---------------------------- retention ------------------------------- */
    AUDIT_RETENTION_DAYS: int(730),
    INDEX_RETENTION_DAYS: int(365),
    IDEMPOTENCY_TTL_HOURS: int(24),

    /* ----------------------------- transport ------------------------------ */
    CORS_ORIGINS: csv(["https://localhost:3000"]),
    RATE_LIMIT_PER_MINUTE: int(120),
    TRUST_PROXY: z.string().default("true"),
    REQUEST_TIMEOUT_MS: int(30000),
    BODY_LIMIT_BYTES: int(2 * 1024 * 1024),
    SHUTDOWN_TIMEOUT_MS: int(25000),
    METRICS_ENABLED: bool(true),
    /** When set, `GET /metrics` requires `Authorization: Bearer <token>`. */
    METRICS_TOKEN: optStr,
    API_DOCS_ENABLED: bool(false),

    /* -------------------------------- misc -------------------------------- */
    AUDIT_STORE_CONTENT: bool(false),
    NOTIFY_WEBHOOK_URL: optStr,
    DEFAULT_LANGUAGE: z.enum(["fr", "en"]).default("fr"),
    /** Overrides DEFAULT_POLICY.internalDomains when no policy row exists. */
    INTERNAL_DOMAINS: csv(["northbridge.example"]),
  })
  .superRefine((cfg, ctx) => {
    const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const prod = cfg.NODE_ENV === "production";
    if (cfg.AUTH_MODE === "dev" && prod) fail("AUTH_MODE", "AUTH_MODE=dev is refused when NODE_ENV=production");
    if (cfg.AUTH_MODE === "aad" && (!cfg.AAD_TENANT_ID || !cfg.AAD_CLIENT_ID)) fail("AUTH_MODE", "AUTH_MODE=aad requires AAD_TENANT_ID and AAD_CLIENT_ID");
    if (cfg.GRAPH_ENABLED && (!cfg.AAD_TENANT_ID || !cfg.AAD_CLIENT_ID || !cfg.AAD_CLIENT_SECRET)) fail("GRAPH_ENABLED", "GRAPH_ENABLED=true requires AAD_TENANT_ID, AAD_CLIENT_ID and AAD_CLIENT_SECRET");
    if (prod && cfg.ADMIN_API_TOKEN.trim().length < 24) fail("ADMIN_API_TOKEN", `ADMIN_API_TOKEN must be at least 24 characters in production (got ${cfg.ADMIN_API_TOKEN.trim().length})`);
    // `credentials: true` + a reflected `*` origin lets any site on the internet
    // make authenticated cross-origin calls with the operator's session.
    if (prod && cfg.CORS_ORIGINS.includes("*")) fail("CORS_ORIGINS", "CORS_ORIGINS=* is refused when NODE_ENV=production (credentialed CORS must name the add-in origins)");
    if (prod && cfg.AUDIT_STORE_CONTENT && !cfg.ADMIN_API_TOKEN) fail("AUDIT_STORE_CONTENT", "AUDIT_STORE_CONTENT=true in production requires an explicit compliance sign-off (see docs/SECURITY.md)");
    if (cfg.GRAPH_AUTH_MODE === "app" && cfg.GRAPH_ENABLED && !cfg.SYNC_USERS.length && !cfg.SYNC_GROUP_ID) fail("GRAPH_AUTH_MODE", "GRAPH_AUTH_MODE=app requires SYNC_USERS or SYNC_GROUP_ID");
    if (cfg.DAILY_BRIEF_HOUR < 0 || cfg.DAILY_BRIEF_HOUR > 23) fail("DAILY_BRIEF_HOUR", "DAILY_BRIEF_HOUR must be between 0 and 23");
    if (cfg.LLM_CONCURRENCY < 1) fail("LLM_CONCURRENCY", "LLM_CONCURRENCY must be >= 1");
    if (cfg.EMBEDDING_BATCH_SIZE < 1 || cfg.EMBEDDING_BATCH_SIZE > 512) fail("EMBEDDING_BATCH_SIZE", "EMBEDDING_BATCH_SIZE must be between 1 and 512");
    if (cfg.LLM_INPUT_MAX_CHARS < 500) fail("LLM_INPUT_MAX_CHARS", "LLM_INPUT_MAX_CHARS must be >= 500");
    if (cfg.THREAD_MAX_MESSAGES < 1) fail("THREAD_MAX_MESSAGES", "THREAD_MAX_MESSAGES must be >= 1");
  });

export type Config = z.infer<typeof ConfigSchema>;

export const APP_VERSION = "0.1.0";

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  cfg: Config;
  /** Variables filled from a `*_FILE` mount (names only). */
  secretsFromFiles: string[];
}

/** Validate the environment, reporting every problem at once (fail fast, readable). */
export function loadConfigDetailed(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const resolved = resolveSecretFiles(env);
  const parsed = ConfigSchema.safeParse(resolved.env);
  const problems = [...resolved.errors];
  if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`));
  if (problems.length) throw new ConfigError(problems);
  return { cfg: parsed.data!, secretsFromFiles: resolved.fromFiles };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return loadConfigDetailed(env).cfg;
}

export const isMemoryDatabase = (cfg: Config): boolean => cfg.DATABASE_URL.trim().toLowerCase() === "memory";

/** True when this process must serve HTTP. */
export const servesApi = (cfg: Config): boolean => cfg.ROLE === "api" || cfg.ROLE === "all";
/** True when this process must run the scheduler (sync, brief, retention). */
export const runsWorkers = (cfg: Config): boolean => cfg.WORKERS_ENABLED && (cfg.ROLE === "worker" || cfg.ROLE === "all");

/**
 * `trustProxy` value for Fastify: `true`/`false`, a hop count (passed through as
 * a string, which Fastify's proxy-addr understands) or a comma-separated
 * IP/CIDR allow-list. Behind an ingress this decides whether `req.ip` is the
 * client or the load balancer, which in turn decides who gets rate-limited.
 */
export function trustProxyOption(value: string): boolean | string | string[] {
  const v = value.trim().toLowerCase();
  if (["", "true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (/^\d+$/.test(v)) return v;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 1 ? list : (list[0] ?? true);
}

/** Non-secret, fully-resolved configuration, printed once at startup. */
export function effectiveConfig(cfg: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg).sort(([a], [b]) => a.localeCompare(b))) {
    out[key] = redactValue(key, value);
  }
  return out;
}

import { z } from "zod";
import { MODEL_NAME_PATTERN } from "./domain/decisions/schemas.js";
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
/**
 * Number whose empty value means "default". `z.coerce.number()` turns `""`
 * into 0, which for a threshold such as `LAYA_MIN_CONFIDENCE=` would silently
 * accept every answer. A non-number becomes NaN instead of a schema error, so
 * the range checks in `superRefine` report it together with every other
 * problem (fail fast, but with the complete list).
 */
const num = (def: number) =>
  z.preprocess((v) => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.trim())) : v), z.union([z.number(), z.nan()]).default(def));

/** Laya knobs that must be strictly positive integers. */
const LAYA_POSITIVE_INTS = ["LAYA_TIMEOUT_MS", "LAYA_MAX_RESPONSE_BYTES", "LAYA_CONCURRENCY", "LAYA_CIRCUIT_FAILURE_THRESHOLD", "LAYA_CIRCUIT_COOLDOWN_MS", "LAYA_INPUT_MAX_CHARS"] as const;
/** Laya knobs that are ratios in [0, 1]. */
const LAYA_RATIOS = ["LAYA_MIN_CONFIDENCE", "LAYA_FOLDER_MIN_CONFIDENCE", "LAYA_SHADOW_SAMPLE_RATE"] as const;

const ConfigObjectSchema = z
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
    /**
     * Index every email the add-in sends for analysis (once per email). Without
     * Microsoft Graph this is what fills the "all emails" retrieval scope of
     * the chat: the mailbox the assistant knows is the mailbox the user browsed.
     */
    INDEX_ON_ANALYZE: bool(true),
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

    /* ----------------- structured decisions (Laya, docs/LAYA.md) ----------------- */
    /**
     * `disabled` (default): historic behaviour, no decision engine at all.
     * `mock`: deterministic in-process provider (demo, tests).
     * `laya`: `laya-serve` over HTTP (`POST /v1/systemone`).
     */
    DECISION_PROVIDER: z.enum(["disabled", "mock", "laya"]).default("disabled"),
    /** `shadow`: decisions are audited and measured, never shown. `active`: they drive the analysis. */
    LAYA_MODE: z.enum(["shadow", "active"]).default("shadow"),
    LAYA_BASE_URL: z.string().default("http://laya:8000"),
    /** Bearer token expected by laya-serve (`LAYA_API_KEY` on its side). Never logged, never exposed. */
    LAYA_API_KEY: optStr,
    /** Per-call timeout; also the longest wait for a concurrency slot. */
    LAYA_TIMEOUT_MS: num(5000),
    LAYA_MAX_RESPONSE_BYTES: num(1_048_576),
    /** Minimum engine confidence for urgency, business area, reply / action expected. */
    LAYA_MIN_CONFIDENCE: num(0.75),
    /** Minimum confidence of a folder decision before a `move_to_folder` suggestion is made. */
    LAYA_FOLDER_MIN_CONFIDENCE: num(0.8),
    /** When a decision is unusable (outage, low confidence): true = the historic full LLM prompt classifies; false = no classification. */
    LAYA_FALLBACK_TO_LLM: bool(true),
    /** In-flight decision calls per orchestrator process (one laya-serve pod serialises inference). */
    LAYA_CONCURRENCY: num(1),
    LAYA_CIRCUIT_FAILURE_THRESHOLD: num(5),
    LAYA_CIRCUIT_COOLDOWN_MS: num(30000),
    /** Folder taxonomy (JSON). Empty = the example bundled with the orchestrator (refused for laya+active in production). */
    LAYA_TAXONOMY_FILE: optStr,
    /** Bumped whenever questions / criteria / mapping change: part of every analysis cache key and audit record. */
    LAYA_DECISION_VERSION: z.string().default("v1"),
    /** Cap on the email body sent to the engine (head + tail kept). */
    LAYA_INPUT_MAX_CHARS: num(4000),
    /** `language`: english for English mail, multilingual otherwise. `auto`: let laya-serve route. `fixed`: always LAYA_FIXED_MODEL. */
    LAYA_MODEL_STRATEGY: z.enum(["language", "auto", "fixed"]).default("language"),
    LAYA_FIXED_MODEL: optStr,
    /** Shadow mode only: fraction of analysed emails also sent to the engine (deterministic by content hash). */
    LAYA_SHADOW_SAMPLE_RATE: num(1),

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
  });

export const ConfigSchema = ConfigObjectSchema
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

    /* ------------------------- structured decisions ------------------------ */
    // Always validated (cheap, and a typo should not wait for the day the engine is switched on)…
    for (const key of LAYA_RATIOS) {
      const v = cfg[key];
      if (!(Number.isFinite(v) && v >= 0 && v <= 1)) fail(key, `${key} must be a number between 0 and 1 (got ${v})`);
    }
    for (const key of LAYA_POSITIVE_INTS) {
      const v = cfg[key];
      if (!(Number.isInteger(v) && v > 0)) fail(key, `${key} must be a positive integer (got ${v})`);
    }
    if (cfg.LAYA_INPUT_MAX_CHARS > 20_000) fail("LAYA_INPUT_MAX_CHARS", "LAYA_INPUT_MAX_CHARS must be <= 20000 (the engine reads a few hundred tokens of state; see docs/LAYA.md)");
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(cfg.LAYA_DECISION_VERSION)) fail("LAYA_DECISION_VERSION", "LAYA_DECISION_VERSION must be 1-32 characters among letters, digits, '.', '_' and '-'");
    if (cfg.LAYA_FIXED_MODEL && !MODEL_NAME_PATTERN.test(cfg.LAYA_FIXED_MODEL)) fail("LAYA_FIXED_MODEL", "LAYA_FIXED_MODEL must be a checkpoint name such as english, multilingual or typed-decisions");
    // …but only an enabled engine may block the start: DECISION_PROVIDER=disabled always boots.
    if (cfg.DECISION_PROVIDER !== "disabled" && cfg.LAYA_MODEL_STRATEGY === "fixed" && !cfg.LAYA_FIXED_MODEL) fail("LAYA_FIXED_MODEL", "LAYA_MODEL_STRATEGY=fixed requires LAYA_FIXED_MODEL (e.g. multilingual)");
    if (cfg.DECISION_PROVIDER === "laya") {
      let url: URL | undefined;
      try {
        url = new URL(cfg.LAYA_BASE_URL);
      } catch {
        fail("LAYA_BASE_URL", `LAYA_BASE_URL is not a valid URL (got "${cfg.LAYA_BASE_URL}")`);
      }
      if (url && url.protocol !== "http:" && url.protocol !== "https:") fail("LAYA_BASE_URL", "LAYA_BASE_URL must be an http(s) URL");
      if (url && (url.username || url.password)) fail("LAYA_BASE_URL", "LAYA_BASE_URL must not embed credentials — use LAYA_API_KEY / LAYA_API_KEY_FILE");
      if (cfg.LAYA_MODE === "active" && prod) {
        if (!cfg.LAYA_API_KEY) fail("LAYA_API_KEY", "DECISION_PROVIDER=laya with LAYA_MODE=active requires LAYA_API_KEY (or LAYA_API_KEY_FILE) when NODE_ENV=production");
        if (!cfg.LAYA_TAXONOMY_FILE) fail("LAYA_TAXONOMY_FILE", "DECISION_PROVIDER=laya with LAYA_MODE=active requires an explicit LAYA_TAXONOMY_FILE when NODE_ENV=production (the bundled taxonomy is an example)");
      }
    }
  });

/** Names of every configuration variable (drives the `<NAME>_FILE` secret resolution). */
export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(ConfigObjectSchema.shape));

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
  const resolved = resolveSecretFiles(env, undefined, CONFIG_KEYS);
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

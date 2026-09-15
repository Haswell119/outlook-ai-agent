import { z } from "zod";

/**
 * Environment configuration, validated once at startup (ARCHITECTURE.md §8).
 * Every variable has a safe default so that `LLM_PROVIDER=mock DATABASE_URL=memory`
 * runs without any external dependency.
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

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: int(8080),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    LLM_PROVIDER: z.enum(["openai-compatible", "mock"]).default("openai-compatible"),
    LLM_BASE_URL: z.string().default("http://localhost:8000/v1"),
    LLM_API_KEY: z.string().optional().transform((v) => (v && v.trim() !== "" ? v : undefined)),
    LLM_MODEL: z.string().default("qwen3-30b-a3b"),
    LLM_TIMEOUT_MS: int(60000),
    LLM_MAX_TOKENS: int(2048),
    LLM_JSON_MODE: z.enum(["auto", "response_format", "prompt"]).default("auto"),
    EMBEDDINGS_ENABLED: bool(true),
    EMBEDDING_MODEL: z.string().default("bge-m3"),
    EMBEDDING_DIMENSIONS: int(1024),

    DATABASE_URL: z.string().default("postgres://oao:oao@localhost:5432/oao"),
    DB_AUTO_MIGRATE: bool(true),
    DEMO_SEED: bool(true),

    AUTH_MODE: z.enum(["dev", "aad"]).default("dev"),
    AAD_TENANT_ID: z.string().optional(),
    AAD_CLIENT_ID: z.string().optional(),
    AAD_CLIENT_SECRET: z.string().optional(),
    ADMIN_EMAILS: csv(["admin@northbridge.example"]),
    COMPLIANCE_EMAILS: csv(["compliance@northbridge.example"]),
    ADMIN_API_TOKEN: z.string().default("change-me"),

    GRAPH_ENABLED: bool(false),

    CORS_ORIGINS: csv(["https://localhost:3000"]),
    RATE_LIMIT_PER_MINUTE: int(120),
    AUDIT_STORE_CONTENT: bool(false),
    NOTIFY_WEBHOOK_URL: z.string().optional().transform((v) => (v && v.trim() !== "" ? v : undefined)),
    DEFAULT_LANGUAGE: z.enum(["fr", "en"]).default("fr"),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.AUTH_MODE === "dev" && cfg.NODE_ENV === "production") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["AUTH_MODE"], message: "AUTH_MODE=dev is refused when NODE_ENV=production" });
    }
    if (cfg.AUTH_MODE === "aad" && (!cfg.AAD_TENANT_ID || !cfg.AAD_CLIENT_ID)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["AUTH_MODE"], message: "AUTH_MODE=aad requires AAD_TENANT_ID and AAD_CLIENT_ID" });
    }
    if (cfg.GRAPH_ENABLED && (!cfg.AAD_TENANT_ID || !cfg.AAD_CLIENT_ID || !cfg.AAD_CLIENT_SECRET)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["GRAPH_ENABLED"], message: "GRAPH_ENABLED=true requires AAD_TENANT_ID, AAD_CLIENT_ID and AAD_CLIENT_SECRET" });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export const APP_VERSION = "0.1.0";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}

export const isMemoryDatabase = (cfg: Config): boolean => cfg.DATABASE_URL.trim().toLowerCase() === "memory";

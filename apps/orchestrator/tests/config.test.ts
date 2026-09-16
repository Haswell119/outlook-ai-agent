import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, effectiveConfig, loadConfig, loadConfigDetailed, runsWorkers, servesApi, trustProxyOption } from "../src/config.js";
import { redactUrl, redactValue, resolveSecretFiles } from "../src/util/secrets.js";

const base = { LLM_PROVIDER: "mock", DATABASE_URL: "memory", NODE_ENV: "test" } as NodeJS.ProcessEnv;

describe("loadConfig — defaults", () => {
  it("runs with no configuration at all", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      TRIAGE_ENABLED: true,
      ANALYSIS_CACHE_ENABLED: true,
      ANALYSIS_CACHE_TTL_HOURS: 168,
      EMBEDDING_CACHE_ENABLED: true,
      LLM_INPUT_MAX_CHARS: 12_000,
      THREAD_MAX_MESSAGES: 12,
      LLM_CONCURRENCY: 4,
      LLM_CIRCUIT_FAILURES: 5,
      LLM_CIRCUIT_COOLDOWN_MS: 30_000,
      EMBEDDING_BATCH_SIZE: 64,
      SYNC_INTERVAL_MINUTES: 10,
      DAILY_BRIEF_HOUR: 7,
      AUDIT_RETENTION_DAYS: 730,
      INDEX_RETENTION_DAYS: 365,
      IDEMPOTENCY_TTL_HOURS: 24,
      ROLE: "api",
      GRAPH_AUTH_MODE: "obo",
      ORGANIZATION_NAME: "Northbridge Capital",
      TZ: "UTC",
    });
    expect(cfg.INTERNAL_DOMAINS).toEqual(["northbridge.example"]);
    expect(cfg.LLM_FAST_MODEL).toBeUndefined();
  });

  it("INTERNAL_DOMAINS and ORGANIZATION_NAME are configurable", () => {
    const cfg = loadConfig({ ...base, INTERNAL_DOMAINS: "northbridge.example, nb-capital.example ,", ORGANIZATION_NAME: "Northbridge Capital AG" });
    expect(cfg.INTERNAL_DOMAINS).toEqual(["northbridge.example", "nb-capital.example"]);
    expect(cfg.ORGANIZATION_NAME).toBe("Northbridge Capital AG");
  });

  it("booleans accept the usual spellings", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(loadConfig({ ...base, TRIAGE_ENABLED: v }).TRIAGE_ENABLED).toBe(true);
    for (const v of ["0", "false", "no", "off", "anything-else"]) expect(loadConfig({ ...base, TRIAGE_ENABLED: v }).TRIAGE_ENABLED).toBe(false);
  });
});

describe("loadConfig — fail fast", () => {
  it("reports every problem at once, not just the first", () => {
    try {
      loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev", ADMIN_API_TOKEN: "short", DAILY_BRIEF_HOUR: "42", LLM_CONCURRENCY: "0" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const problems = (e as ConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(4);
      expect(problems.join("\n")).toContain("AUTH_MODE=dev is refused when NODE_ENV=production");
      expect(problems.join("\n")).toContain("ADMIN_API_TOKEN must be at least 24 characters");
      expect(problems.join("\n")).toContain("DAILY_BRIEF_HOUR must be between 0 and 23");
      expect(problems.join("\n")).toContain("LLM_CONCURRENCY must be >= 1");
      expect((e as ConfigError).message).toContain("Invalid configuration");
    }
  });

  it("accepts a long ADMIN_API_TOKEN in production", () => {
    const cfg = loadConfig({ NODE_ENV: "production", AUTH_MODE: "aad", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", ADMIN_API_TOKEN: "a".repeat(24), DATABASE_URL: "postgres://u:p@h:5432/d" });
    expect(cfg.NODE_ENV).toBe("production");
  });

  it("GRAPH_ENABLED requires the AAD triplet", () => {
    expect(() => loadConfig({ ...base, GRAPH_ENABLED: "true" })).toThrow(/AAD_TENANT_ID/);
  });

  it("GRAPH_AUTH_MODE=app requires SYNC_USERS or SYNC_GROUP_ID", () => {
    const withGraph = { ...base, GRAPH_ENABLED: "true", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", AAD_CLIENT_SECRET: "s", GRAPH_AUTH_MODE: "app" };
    expect(() => loadConfig(withGraph)).toThrow(/SYNC_USERS or SYNC_GROUP_ID/);
    expect(loadConfig({ ...withGraph, SYNC_USERS: "a@northbridge.example" }).GRAPH_AUTH_MODE).toBe("app");
    expect(loadConfig({ ...withGraph, SYNC_GROUP_ID: "group-1" }).SYNC_GROUP_ID).toBe("group-1");
  });

  it("rejects nonsensical AI-load knobs", () => {
    expect(() => loadConfig({ ...base, LLM_INPUT_MAX_CHARS: "100" })).toThrow(/LLM_INPUT_MAX_CHARS must be >= 500/);
    expect(() => loadConfig({ ...base, THREAD_MAX_MESSAGES: "0" })).toThrow(/THREAD_MAX_MESSAGES must be >= 1/);
    expect(() => loadConfig({ ...base, EMBEDDING_BATCH_SIZE: "1000" })).toThrow(/EMBEDDING_BATCH_SIZE must be between 1 and 512/);
  });
});

describe("*_FILE secrets (Kubernetes / NKP mounts)", () => {
  const files: Record<string, string> = {
    "/run/secrets/db": "postgres://oao:s3cret@db:5432/oao\n",
    "/run/secrets/llm": "sk-internal-key\n\n",
    "/run/secrets/aad": "aad-client-secret",
  };
  const read = (p: string) => {
    if (!(p in files)) throw new Error("ENOENT: no such file");
    return files[p]!;
  };

  it("fills the variable from the file and strips trailing newlines", () => {
    const r = resolveSecretFiles({ DATABASE_URL_FILE: "/run/secrets/db", LLM_API_KEY_FILE: "/run/secrets/llm" }, read);
    expect(r.env.DATABASE_URL).toBe("postgres://oao:s3cret@db:5432/oao");
    expect(r.env.LLM_API_KEY).toBe("sk-internal-key");
    expect(r.fromFiles.sort()).toEqual(["DATABASE_URL", "LLM_API_KEY"]);
    expect(r.errors).toEqual([]);
  });

  it("an explicit non-empty variable wins over the file", () => {
    const r = resolveSecretFiles({ LLM_API_KEY: "from-env", LLM_API_KEY_FILE: "/run/secrets/llm" }, read);
    expect(r.env.LLM_API_KEY).toBe("from-env");
    expect(r.fromFiles).toEqual([]);
  });

  it("an unreadable file is a fatal configuration error", () => {
    expect(() => loadConfigDetailed({ ...base, AAD_CLIENT_SECRET_FILE: "/run/secrets/missing" })).toThrow(/cannot read \/run\/secrets\/missing/);
  });

  it("loadConfigDetailed reads real mounted files end to end", () => {
    // A real mount, the way Kubernetes presents a Secret volume.
    const dir = mkdtempSync(path.join(tmpdir(), "oao-secrets-"));
    writeFileSync(path.join(dir, "admin-token"), "an-admin-token-of-more-than-24-chars\n");
    writeFileSync(path.join(dir, "llm-key"), "sk-internal-key\n");

    const { cfg, secretsFromFiles } = loadConfigDetailed({
      LLM_PROVIDER: "mock",
      DATABASE_URL: "memory",
      NODE_ENV: "production",
      AUTH_MODE: "aad",
      AAD_TENANT_ID: "tenant",
      AAD_CLIENT_ID: "client",
      ADMIN_API_TOKEN_FILE: path.join(dir, "admin-token"),
      LLM_API_KEY_FILE: path.join(dir, "llm-key"),
    });
    expect(cfg.ADMIN_API_TOKEN).toBe("an-admin-token-of-more-than-24-chars");
    expect(cfg.LLM_API_KEY).toBe("sk-internal-key");
    expect(secretsFromFiles.sort()).toEqual(["ADMIN_API_TOKEN", "LLM_API_KEY"]);
    // The banner still hides them.
    expect(JSON.stringify(effectiveConfig(cfg))).not.toContain("sk-internal-key");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores an empty *_FILE value and a bare _FILE key", () => {
    const r = resolveSecretFiles({ LLM_API_KEY_FILE: "   ", _FILE: "/run/secrets/db" }, read);
    expect(r.env.LLM_API_KEY).toBeUndefined();
    expect(r.errors).toEqual([]);
  });
});

describe("startup banner redaction", () => {
  it("never prints a secret", () => {
    const cfg = loadConfig({ ...base, DATABASE_URL: "postgres://oao:sup3rs3cret@db.internal:5432/oao", LLM_API_KEY: "sk-abc", ADMIN_API_TOKEN: "admin-token-value", METRICS_TOKEN: "metrics-token", NOTIFY_WEBHOOK_URL: "https://hooks.internal/x?token=abc" });
    const printed = effectiveConfig(cfg);
    const text = JSON.stringify(printed);
    expect(text).not.toContain("sup3rs3cret");
    expect(text).not.toContain("sk-abc");
    expect(text).not.toContain("admin-token-value");
    expect(text).not.toContain("metrics-token");
    expect(text).not.toContain("token=abc");
    // Non-secret values are still visible, and the DB host is kept for diagnosis.
    expect(printed.DATABASE_URL).toBe("postgres://oao:***@db.internal:5432/oao");
    expect(printed.TRIAGE_ENABLED).toBe(true);
    expect(printed.LLM_MODEL).toBe("qwen3-30b-a3b");
  });

  it("redactUrl / redactValue handle odd inputs", () => {
    expect(redactUrl("postgres://h:5432/d")).toBe("postgres://h:5432/d");
    expect(redactValue("LLM_MODEL", "qwen3")).toBe("qwen3");
    expect(redactValue("LLM_API_KEY", "")).toBe("");
    expect(redactValue("LLM_API_KEY", undefined)).toBeUndefined();
  });
});

describe("role and proxy helpers", () => {
  it("ROLE decides what the process does", () => {
    const api = loadConfig({ ...base, ROLE: "api" });
    const worker = loadConfig({ ...base, ROLE: "worker" });
    const all = loadConfig({ ...base, ROLE: "all" });
    expect([servesApi(api), runsWorkers(api)]).toEqual([true, false]);
    expect([servesApi(worker), runsWorkers(worker)]).toEqual([false, true]);
    expect([servesApi(all), runsWorkers(all)]).toEqual([true, true]);
    expect(runsWorkers(loadConfig({ ...base, ROLE: "all", WORKERS_ENABLED: "false" }))).toBe(false);
  });

  it("trustProxyOption understands booleans, hop counts and lists", () => {
    expect(trustProxyOption("true")).toBe(true);
    expect(trustProxyOption("")).toBe(true);
    expect(trustProxyOption("false")).toBe(false);
    expect(trustProxyOption("2")).toBe("2");
    expect(trustProxyOption("10.0.0.0/8,192.168.0.0/16")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    expect(trustProxyOption("10.0.0.1")).toBe("10.0.0.1");
  });
});

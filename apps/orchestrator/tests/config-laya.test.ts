import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, effectiveConfig, loadConfig, loadConfigDetailed } from "../src/config.js";

const base = { LLM_PROVIDER: "mock", DATABASE_URL: "memory", NODE_ENV: "test" } as NodeJS.ProcessEnv;
const prod = { NODE_ENV: "production", AUTH_MODE: "aad", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", ADMIN_API_TOKEN: "a".repeat(24), DATABASE_URL: "postgres://u:p@h:5432/d" } as NodeJS.ProcessEnv;

function problems(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems;
  }
}

describe("structured decisions — configuration", () => {
  it("is disabled by default, with the documented defaults", () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({
      DECISION_PROVIDER: "disabled",
      LAYA_MODE: "shadow",
      LAYA_BASE_URL: "http://laya:8000",
      LAYA_TIMEOUT_MS: 5000,
      LAYA_MAX_RESPONSE_BYTES: 1_048_576,
      LAYA_MIN_CONFIDENCE: 0.75,
      LAYA_FOLDER_MIN_CONFIDENCE: 0.8,
      LAYA_FALLBACK_TO_LLM: true,
      LAYA_CONCURRENCY: 1,
      LAYA_CIRCUIT_FAILURE_THRESHOLD: 5,
      LAYA_CIRCUIT_COOLDOWN_MS: 30000,
      LAYA_DECISION_VERSION: "v1",
      LAYA_INPUT_MAX_CHARS: 4000,
      LAYA_MODEL_STRATEGY: "language",
      LAYA_SHADOW_SAMPLE_RATE: 1,
    });
    expect(cfg.LAYA_API_KEY).toBeUndefined();
    expect(cfg.LAYA_TAXONOMY_FILE).toBeUndefined();
    expect(cfg.LAYA_FIXED_MODEL).toBeUndefined();
  });

  it("an empty numeric value means the default, never 0", () => {
    const cfg = loadConfig({ ...base, LAYA_MIN_CONFIDENCE: "", LAYA_FOLDER_MIN_CONFIDENCE: "  ", LAYA_TIMEOUT_MS: "" });
    expect(cfg.LAYA_MIN_CONFIDENCE).toBe(0.75);
    expect(cfg.LAYA_FOLDER_MIN_CONFIDENCE).toBe(0.8);
    expect(cfg.LAYA_TIMEOUT_MS).toBe(5000);
  });

  it("rejects unknown enum values", () => {
    expect(problems({ ...base, DECISION_PROVIDER: "jev" }).join()).toMatch(/DECISION_PROVIDER/);
    expect(problems({ ...base, LAYA_MODE: "on" }).join()).toMatch(/LAYA_MODE/);
    expect(problems({ ...base, LAYA_MODEL_STRATEGY: "best" }).join()).toMatch(/LAYA_MODEL_STRATEGY/);
  });

  it("thresholds must be within [0, 1]; delays and limits positive integers — all reported at once", () => {
    const p = problems({ ...base, LAYA_MIN_CONFIDENCE: "1.2", LAYA_FOLDER_MIN_CONFIDENCE: "-0.1", LAYA_SHADOW_SAMPLE_RATE: "abc", LAYA_TIMEOUT_MS: "0", LAYA_MAX_RESPONSE_BYTES: "-5", LAYA_CONCURRENCY: "1.5", LAYA_CIRCUIT_FAILURE_THRESHOLD: "0", LAYA_CIRCUIT_COOLDOWN_MS: "-1", LAYA_INPUT_MAX_CHARS: "0" }).join("\n");
    for (const key of ["LAYA_MIN_CONFIDENCE must be a number between 0 and 1", "LAYA_FOLDER_MIN_CONFIDENCE must be a number between 0 and 1", "LAYA_SHADOW_SAMPLE_RATE", "LAYA_TIMEOUT_MS must be a positive integer", "LAYA_MAX_RESPONSE_BYTES must be a positive integer", "LAYA_CONCURRENCY must be a positive integer", "LAYA_CIRCUIT_FAILURE_THRESHOLD must be a positive integer", "LAYA_CIRCUIT_COOLDOWN_MS must be a positive integer", "LAYA_INPUT_MAX_CHARS must be a positive integer"]) {
      expect(p).toContain(key);
    }
    expect(problems({ ...base, LAYA_INPUT_MAX_CHARS: "50000" }).join()).toMatch(/LAYA_INPUT_MAX_CHARS must be <= 20000/);
    expect(problems({ ...base, LAYA_DECISION_VERSION: "v 1/../" }).join()).toMatch(/LAYA_DECISION_VERSION/);
    expect(loadConfig({ ...base, LAYA_MIN_CONFIDENCE: "0", LAYA_FOLDER_MIN_CONFIDENCE: "1" }).LAYA_FOLDER_MIN_CONFIDENCE).toBe(1);
  });

  it("fixed strategy requires LAYA_FIXED_MODEL — but only when an engine is enabled", () => {
    expect(problems({ ...base, DECISION_PROVIDER: "laya", LAYA_MODEL_STRATEGY: "fixed" }).join()).toMatch(/LAYA_MODEL_STRATEGY=fixed requires LAYA_FIXED_MODEL/);
    expect(problems({ ...base, DECISION_PROVIDER: "mock", LAYA_MODEL_STRATEGY: "fixed" }).join()).toMatch(/LAYA_FIXED_MODEL/);
    expect(loadConfig({ ...base, DECISION_PROVIDER: "disabled", LAYA_MODEL_STRATEGY: "fixed" }).LAYA_MODEL_STRATEGY).toBe("fixed");
    expect(loadConfig({ ...base, DECISION_PROVIDER: "laya", LAYA_MODEL_STRATEGY: "fixed", LAYA_FIXED_MODEL: "multilingual" }).LAYA_FIXED_MODEL).toBe("multilingual");
    expect(problems({ ...base, LAYA_FIXED_MODEL: "multi lingual; rm -rf" }).join()).toMatch(/LAYA_FIXED_MODEL must be a checkpoint name/);
  });

  it("validates LAYA_BASE_URL when the provider is laya", () => {
    expect(problems({ ...base, DECISION_PROVIDER: "laya", LAYA_BASE_URL: "not a url" }).join()).toMatch(/LAYA_BASE_URL is not a valid URL/);
    expect(problems({ ...base, DECISION_PROVIDER: "laya", LAYA_BASE_URL: "file:///etc/passwd" }).join()).toMatch(/http\(s\) URL/);
    expect(problems({ ...base, DECISION_PROVIDER: "laya", LAYA_BASE_URL: "http://user:secret@laya:8000" }).join()).toMatch(/must not embed credentials/);
    expect(loadConfig({ ...base, DECISION_PROVIDER: "disabled", LAYA_BASE_URL: "not a url" }).DECISION_PROVIDER).toBe("disabled");
  });

  it("production + laya + active is validated strictly (key and taxonomy file); shadow and disabled stay bootable", () => {
    const p = problems({ ...prod, DECISION_PROVIDER: "laya", LAYA_MODE: "active" }).join("\n");
    expect(p).toMatch(/requires LAYA_API_KEY \(or LAYA_API_KEY_FILE\)/);
    expect(p).toMatch(/requires an explicit LAYA_TAXONOMY_FILE/);
    expect(loadConfig({ ...prod, DECISION_PROVIDER: "laya", LAYA_MODE: "active", LAYA_API_KEY: "k", LAYA_TAXONOMY_FILE: "/etc/oao/laya-taxonomy.json" }).LAYA_MODE).toBe("active");
    expect(loadConfig({ ...prod, DECISION_PROVIDER: "laya", LAYA_MODE: "shadow" }).LAYA_MODE).toBe("shadow");
    expect(loadConfig({ ...prod }).DECISION_PROVIDER).toBe("disabled");
  });

  it("reads LAYA_API_KEY from LAYA_API_KEY_FILE and never prints it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oao-laya-"));
    const file = path.join(dir, "api-key");
    writeFileSync(file, "laya-mounted-secret-5e2f\n");
    const { cfg, secretsFromFiles } = loadConfigDetailed({ ...base, DECISION_PROVIDER: "laya", LAYA_API_KEY_FILE: file });
    expect(cfg.LAYA_API_KEY).toBe("laya-mounted-secret-5e2f");
    expect(secretsFromFiles).toEqual(["LAYA_API_KEY"]);
    const banner = JSON.stringify(effectiveConfig(cfg));
    expect(banner).not.toContain("laya-mounted-secret-5e2f");
    expect(effectiveConfig(cfg).LAYA_API_KEY).toBe("***");
    rmSync(dir, { recursive: true, force: true });
    expect(() => loadConfigDetailed({ ...base, LAYA_API_KEY_FILE: path.join(dir, "gone") })).toThrow(/LAYA_API_KEY_FILE: cannot read/);
  });
});

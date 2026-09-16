import { describe, expect, it } from "vitest";
import { resolveSecretFiles } from "../src/util/secrets.js";
import { CONFIG_KEYS, loadConfigDetailed } from "../src/config.js";

describe("*_FILE secret resolution", () => {
  it("ignores the env-file switches and unknown *_FILE variables", () => {
    const r = resolveSecretFiles({ OAO_SKIP_ENV_FILE: "1", OAO_ENV_FILE: "/nowhere/.env", RANDOM_FILE: "/nowhere/x" }, () => "secret", CONFIG_KEYS);
    expect(r.errors).toEqual([]);
    expect(r.fromFiles).toEqual([]);
  });

  it("still fills a known key from its _FILE twin", () => {
    const r = resolveSecretFiles({ LLM_API_KEY_FILE: "/run/secrets/key" }, () => "sk-test\n", CONFIG_KEYS);
    expect(r.env.LLM_API_KEY).toBe("sk-test");
    expect(r.fromFiles).toEqual(["LLM_API_KEY"]);
  });

  it("loadConfig accepts OAO_SKIP_ENV_FILE=1", () => {
    const loaded = loadConfigDetailed({ NODE_ENV: "test", OAO_SKIP_ENV_FILE: "1", LLM_PROVIDER: "mock", DATABASE_URL: "memory" });
    expect(loaded.cfg.LLM_PROVIDER).toBe("mock");
  });
});

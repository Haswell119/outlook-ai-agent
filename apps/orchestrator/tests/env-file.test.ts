import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFiles, parseEnvFile } from "../src/env-file.js";

describe("env-file", () => {
  it("parses KEY=value, export, quotes and comments", () => {
    const parsed = parseEnvFile(`# comment\nA=1\nexport B="two words" \nC='x' \nD=raw # trailing\n\nE=\n`);
    expect(parsed).toEqual({ A: "1", B: "two words", C: "x", D: "raw", E: "" });
  });

  it("app file overrides root file, and existing variables always win", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oao-env-"));
    const app = path.join(dir, "app.env");
    const root = path.join(dir, "root.env");
    writeFileSync(app, "LLM_MODEL=from-app\n");
    writeFileSync(root, "LLM_MODEL=from-root\nLLM_BASE_URL=http://root:8000/v1\nPORT=9999\n");
    const env: NodeJS.ProcessEnv = { NODE_ENV: "development", PORT: "8080" };
    const loaded = loadEnvFiles([app, root, path.join(dir, "missing.env")], env);
    expect(loaded).toEqual([app, root]);
    expect(env.LLM_MODEL).toBe("from-app");
    expect(env.LLM_BASE_URL).toBe("http://root:8000/v1");
    expect(env.PORT).toBe("8080");
  });

  it("is a no-op under NODE_ENV=test", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    expect(loadEnvFiles(["/nonexistent"], env)).toEqual([]);
  });
});

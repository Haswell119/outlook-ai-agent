/**
 * Validates a manifest with office-addin-manifest after replacing the {{AAD_CLIENT_ID}}
 * placeholder by a dummy GUID (the real id is only known at deployment time).
 * Usage: node scripts/validate-manifest.mjs [manifest/manifest.xml]
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const file = process.argv[2] ?? "manifest/manifest.xml";
const dir = mkdtempSync(join(tmpdir(), "oao-manifest-"));
const tmp = join(dir, "manifest.xml");
writeFileSync(tmp, readFileSync(file, "utf8").replaceAll("{{AAD_CLIENT_ID}}", "00000000-0000-4000-8000-000000000000"));
const bin = process.platform === "win32" ? "office-addin-manifest.cmd" : "office-addin-manifest";
const r = spawnSync(bin, ["validate", tmp], { stdio: "inherit", shell: process.platform === "win32" });
rmSync(dir, { recursive: true, force: true });
process.exit(r.status ?? 1);

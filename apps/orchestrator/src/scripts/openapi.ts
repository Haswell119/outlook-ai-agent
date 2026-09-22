import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../openapi.js";

/**
 * Build step: emit `openapi.json` next to the package root so it can be
 * published, diffed in review and fed to client generators.
 * Run by `npm run build -w @oao/orchestrator`.
 */
const out = process.argv[2] ?? path.resolve(fileURLToPath(new URL("../../", import.meta.url)), "openapi.json");
const doc = buildOpenApiDocument();
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
const paths = Object.keys((doc.paths ?? {}) as Record<string, unknown>).length;
const schemas = Object.keys(((doc.components as Record<string, unknown> | undefined)?.schemas ?? {}) as Record<string, unknown>).length;
console.log(`openapi.json written to ${out} (${paths} paths, ${schemas} schemas)`);

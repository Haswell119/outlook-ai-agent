#!/usr/bin/env node
/**
 * `pnpm setup:dev` — one-shot developer bootstrap (Windows / macOS / Linux).
 *
 *   1. copy .env.example -> .env when missing
 *   2. check Node / pnpm / Docker
 *   3. start the dev PostgreSQL (unless --no-db or DATABASE_URL=memory)
 *   4. install dependencies and build @oao/shared
 *   5. print the next commands
 *
 * Nothing here depends on bash: it replaces the old shell bootstrap script.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  die,
  has,
  helpIfRequested,
  info,
  loadEnv,
  ok,
  parseArgs,
  pnpm,
  repoRoot,
  run,
  step,
  style,
  warn,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), {
  booleans: ["no-db", "no-install", "help", "h"],
});

helpIfRequested(
  flags,
  `
Usage: pnpm setup:dev [options]

Prepares a local development environment:
  - creates .env from .env.example if it does not exist
  - verifies Node >= 20 and pnpm
  - starts PostgreSQL/pgvector with docker compose (skipped with --no-db
    or when DATABASE_URL=memory)
  - installs dependencies and builds @oao/shared

Options:
  --no-db        do not start the PostgreSQL container
  --no-install   skip "pnpm install" (only .env + checks)
  -h, --help     show this help
`,
);

step("Outlook AI Orchestrator — setup:dev");

/* -- 1. Node version ------------------------------------------------------- */
const major = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(major) || major < 20) {
  die(`Node 20+ is required (found ${process.versions.node}). See docs/SETUP.md.`);
}
ok(`Node ${process.versions.node}`);

/* -- 2. .env --------------------------------------------------------------- */
const envFile = join(repoRoot, ".env");
const envExample = join(repoRoot, ".env.example");
if (existsSync(envFile)) {
  ok(".env already exists (left untouched)");
} else {
  if (!existsSync(envExample)) die(".env.example is missing from the repository");
  copyFileSync(envExample, envFile);
  ok(".env created from .env.example");
  info("Demo mode defaults: LLM_PROVIDER=mock, DATABASE_URL=memory, AUTH_MODE=dev");
}

const env = loadEnv(envFile, { quiet: true });
const usesMemoryDb = (env.DATABASE_URL ?? "memory").trim() === "memory";

/* -- 3. pnpm --------------------------------------------------------------- */
if (!has("pnpm")) {
  die(
    "pnpm not found. Enable it with:\n" +
      "     corepack enable && corepack prepare pnpm@10.33.0 --activate",
  );
}
ok("pnpm found");

/* -- 4. database ----------------------------------------------------------- */
if (flags["no-db"]) {
  info("--no-db: skipping the PostgreSQL container");
} else if (usesMemoryDb) {
  info("DATABASE_URL=memory: no PostgreSQL needed (demo mode)");
} else if (!has("docker")) {
  warn("docker not found — start PostgreSQL yourself, or set DATABASE_URL=memory in .env");
} else {
  step("Starting PostgreSQL/pgvector (docker compose -f docker-compose.dev.yml)");
  run("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "-d"], { check: false });
}

/* -- 5. install + build shared --------------------------------------------- */
if (flags["no-install"]) {
  info("--no-install: skipping dependency installation");
} else {
  step("Installing dependencies");
  pnpm(["install"]);
  step("Building @oao/shared (every other package depends on it)");
  pnpm(["--filter", "@oao/shared", "build"]);
}

/* -- 6. next steps --------------------------------------------------------- */
console.log(`
${style.bold("Ready.")} Next steps:

  ${style.bold("Demo (mock LLM, in-memory database):")}
    pnpm certs        # local HTTPS certificate for the add-in (once)
    pnpm dev          # orchestrator :8080 · addin :3000 · admin :3001
    pnpm smoke        # end-to-end check against the running orchestrator

  ${style.bold("Full local stack (real PostgreSQL):")}
    pnpm dev:db                      # start / status of the container
    pnpm db:migrate && pnpm db:seed
    pnpm check:llm                   # validate the internal LLM endpoint
    pnpm dev

  ${style.bold("Sideload the add-in into Outlook:")}
    pnpm manifest:sideload

Documentation: docs/SETUP.md (production first), docs/NKP.md (Kubernetes).
`);

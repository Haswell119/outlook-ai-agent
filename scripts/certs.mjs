#!/usr/bin/env node
/**
 * `pnpm certs` — local HTTPS certificate for the add-in.
 *
 * Office Add-ins are only loaded over HTTPS, even on localhost. Three
 * strategies, in order of preference:
 *
 *   1. office-addin-dev-certs (bundled with @oao/addin): installs a CA in the
 *      OS trust store — the only path Outlook desktop accepts without
 *      warnings. Works on Windows, macOS and Linux.
 *   2. mkcert, when installed: same idea, useful if the Office tooling fails.
 *   3. openssl self-signed: last resort; browsers and Outlook will warn.
 *
 * Output: apps/addin/certs/addin.crt + addin.key (mounted by
 * docker-compose.yml into the add-in nginx container).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  capture,
  has,
  helpIfRequested,
  info,
  ok,
  parseArgs,
  pnpm,
  repoRoot,
  run,
  step,
  warn,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2), {
  booleans: ["force", "openssl", "mkcert", "help", "h"],
});

helpIfRequested(
  flags,
  `
Usage: pnpm certs [options]

Generates the HTTPS certificate used by the add-in dev server
(https://localhost:3000) and by the add-in container.

Options:
  --force     regenerate even if apps/addin/certs/addin.crt exists
  --mkcert    force the mkcert strategy
  --openssl   force the openssl self-signed strategy
  -h, --help  show this help

Files written: apps/addin/certs/addin.crt, apps/addin/certs/addin.key
`,
);

const outDir = join(repoRoot, "apps", "addin", "certs");
const certFile = join(outDir, "addin.crt");
const keyFile = join(outDir, "addin.key");

mkdirSync(outDir, { recursive: true });

if (existsSync(certFile) && existsSync(keyFile) && !flags.force) {
  ok(`certificate already present in ${outDir} (use --force to regenerate)`);
  process.exit(0);
}

const hosts = ["localhost", "127.0.0.1", "::1", "addin.localhost"];

function tryOfficeCerts() {
  if (flags.mkcert || flags.openssl) return false;
  step("office-addin-dev-certs (trusted by Outlook desktop)");
  const result = pnpm(["--filter", "@oao/addin", "certs"], { check: false });
  if (result.status !== 0) {
    warn("office-addin-dev-certs failed — falling back");
    return false;
  }
  // The tool writes into ~/.office-addin-dev-certs; copy for the container.
  const src = join(homedir(), ".office-addin-dev-certs");
  const pairs = [
    ["localhost.crt", certFile],
    ["localhost.key", keyFile],
  ];
  let copied = 0;
  for (const [from, to] of pairs) {
    const full = join(src, from);
    if (existsSync(full)) {
      copyFileSync(full, to);
      copied += 1;
    }
  }
  if (copied === 2) {
    ok(`certificate installed and copied to ${outDir}`);
  } else {
    ok("certificate installed in the OS trust store (dev server ready)");
    info(`could not copy from ${src} — the container will generate its own`);
  }
  return true;
}

function tryMkcert() {
  if (flags.openssl || !has("mkcert")) return false;
  step("mkcert (locally trusted certificate)");
  run("mkcert", ["-install"], { check: false });
  const result = run(
    "mkcert",
    ["-cert-file", certFile, "-key-file", keyFile, ...hosts],
    { check: false },
  );
  if (result.status !== 0) {
    warn("mkcert failed — falling back to openssl");
    return false;
  }
  ok(`certificate written to ${outDir}`);
  return true;
}

function tryOpenssl() {
  if (!has("openssl")) return false;
  step("openssl self-signed certificate (browsers and Outlook will warn)");
  const subject = "/C=CH/ST=Geneva/L=Geneva/O=Northbridge Capital/OU=OAO/CN=localhost";
  const san = "subjectAltName=DNS:localhost,DNS:addin.localhost,IP:127.0.0.1";
  const result = run(
    "openssl",
    [
      "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "365",
      "-keyout", keyFile, "-out", certFile,
      "-subj", subject, "-addext", san,
    ],
    { check: false },
  );
  if (result.status !== 0) return false;
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* Windows ignores POSIX modes */
  }
  ok(`self-signed certificate written to ${outDir}`);
  info("Outlook will refuse it: prefer `pnpm certs` without --openssl, or mkcert");
  return true;
}

if (!tryOfficeCerts() && !tryMkcert() && !tryOpenssl()) {
  warn("no certificate tooling available (office-addin-dev-certs, mkcert, openssl)");
  info("Install mkcert (https://github.com/FiloSottile/mkcert) or OpenSSL and retry.");
  process.exit(1);
}

const version = capture("openssl", ["version"]);
if (version) info(version);

console.log(`
Next: pnpm dev   (add-in on https://localhost:3000)
      pnpm manifest:sideload   to load the add-in into Outlook
`);

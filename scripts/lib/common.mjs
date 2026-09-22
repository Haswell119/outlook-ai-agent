/**
 * Shared helpers for the `scripts/*.mjs` developer tooling.
 *
 * Everything here is OS-independent on purpose: no bash, no curl, no sleep,
 * no POSIX-only path handling. Windows, macOS and Linux run the same code.
 */
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (this file is scripts/lib/common.mjs). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";

/* -------------------------------------------------------------------------- */
/*  Console output                                                            */
/* -------------------------------------------------------------------------- */

const ESC = String.fromCharCode(27);
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const style = {
  bold: (s) => paint("1", s),
  dim: (s) => paint("2", s),
  red: (s) => paint("31", s),
  green: (s) => paint("32", s),
  yellow: (s) => paint("33", s),
  cyan: (s) => paint("36", s),
};

export const step = (msg) => console.log(`${style.cyan("==>")} ${msg}`);
export const ok = (msg) => console.log(`${style.green("OK")}   ${msg}`);
export const warn = (msg) => console.warn(`${style.yellow("WARN")} ${msg}`);
export const fail = (msg) => console.error(`${style.red("FAIL")} ${msg}`);
export const info = (msg) => console.log(`     ${style.dim(msg)}`);

/** Print a message and exit with a non-zero status. */
export function die(msg, code = 1) {
  fail(msg);
  process.exit(code);
}

/* -------------------------------------------------------------------------- */
/*  Argument parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `--flag`, `--key=value`, `--key value` and positional parser.
 */
export function parseArgs(argv = process.argv.slice(2), { booleans = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.replace(/^--?/, "");
    if (name.includes("=")) {
      const [k, ...rest] = name.split("=");
      flags[k] = rest.join("=");
      continue;
    }
    const next = argv[i + 1];
    if (booleans.includes(name) || next === undefined || next.startsWith("-")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { flags, positionals };
}

/** Print `text` and exit 0 when --help/-h is present. */
export function helpIfRequested(flags, text) {
  if (flags.help || flags.h) {
    console.log(text.trim());
    process.exit(0);
  }
}

/* -------------------------------------------------------------------------- */
/*  Processes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cross-platform `which`. Honours PATHEXT on Windows so `npm` resolves to
 * `npm.cmd` without the caller having to care.
 */
export function which(command) {
  const pathValue = process.env.PATH ?? "";
  const exts = isWindows
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ""), command + ext);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* unreadable PATH entry: ignore */
      }
    }
  }
  return null;
}

export const has = (command) => which(command) !== null;

/**
 * Run a command synchronously, inheriting stdio.
 * `shell: true` on Windows only, so `.cmd` shims (npm, npx) are found — the
 * arguments never go through a shell on POSIX, which keeps quoting sane.
 */
export function run(command, args = [], { cwd = repoRoot, env, check = true, quiet = false } = {}) {
  if (!quiet) info(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: isWindows,
  });
  if (result.error) {
    if (check) die(`cannot run "${command}": ${result.error.message}`);
    return { status: null, error: result.error };
  }
  if (check && result.status !== 0) {
    die(`"${command} ${args.join(" ")}" exited with code ${result.status}`);
  }
  return result;
}

/** Run a command and capture stdout (never throws; returns "" on failure). */
export function capture(command, args = [], { cwd = repoRoot } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: isWindows });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

/** Open a path in the OS file manager (best effort, never throws). */
export function openPath(target) {
  const command = isWindows ? "explorer" : isMac ? "open" : "xdg-open";
  try {
    spawn(command, [target], { stdio: "ignore", detached: true, shell: isWindows }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run an npm command (`npm` is the only package manager this repository uses —
 * it ships with Node 22, so nothing has to be enabled first).
 */
export const npm = (args, opts) => run("npm", args, opts);

/** `npm run <script> [-w <workspace>]`, the shape every caller here needs. */
export const npmRun = (script, { workspace, ...opts } = {}) =>
  npm(["run", script, ...(workspace ? ["-w", workspace] : [])], opts);

/* -------------------------------------------------------------------------- */
/*  .env handling                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse a dotenv file into a plain object. Supports `KEY=value`,
 * `export KEY=value`, `#` comments and single/double quotes. CRLF-safe.
 */
export function parseEnv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/**
 * Read `.env` (or `file`) if present. Values already exported in the real
 * environment always win, like `docker compose` and dotenv do.
 */
export function loadEnv(file = join(repoRoot, ".env"), { quiet = false } = {}) {
  if (!existsSync(file)) {
    if (!quiet) warn(`${file} not found — using the current environment only`);
    return { ...process.env };
  }
  if (!quiet) step(`Loading ${file}`);
  const parsed = parseEnv(readFileSync(file, "utf8"));
  const merged = { ...parsed };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/*  HTTP + waiting (no curl, no sleep)                                        */
/* -------------------------------------------------------------------------- */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() with a timeout, returning `{ ok, status, body, json, error }`
 * instead of throwing — the scripts report OK/KO per check.
 */
export async function request(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json", ...headers } : headers,
      body: typeof body === "string" || body === undefined ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, body: text, json };
  } catch (error) {
    return { ok: false, status: 0, body: "", error: /** @type {Error} */ (error).message };
  }
}

/** Poll `probe` until it resolves truthy or the timeout elapses. */
export async function waitFor(probe, { timeoutMs = 60000, intervalMs = 1000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= deadline) {
      warn(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
      return false;
    }
    await sleep(intervalMs);
  }
}

/** Truncate a body for log output without breaking the terminal. */
export const preview = (text, max = 220) =>
  text.length > max ? `${text.slice(0, max).replace(/\s+/g, " ")}…` : text.replace(/\s+/g, " ");

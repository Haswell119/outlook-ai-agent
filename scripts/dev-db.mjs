#!/usr/bin/env node
/**
 * `pnpm dev:db [up|down|status|reset|psql]` — the local PostgreSQL/pgvector
 * container used by developers (docker-compose.dev.yml).
 *
 * Replaces the former dev-up/dev-down shell scripts; works identically on
 * Docker Desktop (Windows/macOS) and on Linux.
 */
import {
  die,
  has,
  helpIfRequested,
  info,
  loadEnv,
  ok,
  parseArgs,
  repoRoot,
  run,
  capture,
  step,
  warn,
  waitFor,
} from "./lib/common.mjs";

const COMPOSE_FILE = "docker-compose.dev.yml";

const { flags, positionals } = parseArgs(process.argv.slice(2), {
  booleans: ["volumes", "help", "h"],
});

helpIfRequested(
  flags,
  `
Usage: pnpm dev:db [command] [options]

Commands:
  up       (default) start PostgreSQL/pgvector and wait until it is healthy
  down     stop the container (data volume kept)
  status   show the container state
  logs     follow the container logs
  reset    stop, delete the data volume, start again (DESTROYS local data)
  psql     open an interactive psql session inside the container

Options:
  --volumes   with "down": also delete the data volume
  -h, --help  show this help
`,
);

const command = positionals[0] ?? "up";

if (!has("docker")) {
  die(
    "docker not found.\n" +
      "     Install Docker Desktop (Windows/macOS) or Docker Engine (Linux),\n" +
      "     or set DATABASE_URL=memory in .env to run without PostgreSQL.",
  );
}

const env = loadEnv(undefined, { quiet: true });
const user = env.POSTGRES_USER ?? "oao";
const database = env.POSTGRES_DB ?? "oao";
const port = env.POSTGRES_PORT ?? "5432";

const compose = (args, opts = {}) =>
  run("docker", ["compose", "-f", COMPOSE_FILE, ...args], { cwd: repoRoot, ...opts });

async function waitHealthy() {
  const okHealth = await waitFor(
    () => {
      const state = capture("docker", [
        "compose",
        "-f",
        COMPOSE_FILE,
        "ps",
        "--format",
        "{{.Health}}",
        "postgres",
      ]);
      return state.includes("healthy");
    },
    { timeoutMs: 120000, intervalMs: 2000, label: "PostgreSQL to become healthy" },
  );
  if (okHealth) {
    ok(`PostgreSQL ready on localhost:${port} (user ${user}, database ${database})`);
    info(`DATABASE_URL=postgres://${user}:<password>@localhost:${port}/${database}`);
  } else {
    warn("container still not healthy — inspect it with: pnpm dev:db logs");
  }
}

switch (command) {
  case "up": {
    step("Starting PostgreSQL/pgvector");
    compose(["up", "-d"]);
    await waitHealthy();
    break;
  }
  case "down": {
    if (flags.volumes) {
      step("Stopping the dev stack and deleting the data volume");
      compose(["down", "--volumes"]);
    } else {
      step("Stopping the dev stack (data volume kept — use --volumes to wipe it)");
      compose(["down"]);
    }
    break;
  }
  case "status": {
    compose(["ps"]);
    break;
  }
  case "logs": {
    compose(["logs", "-f", "postgres"], { check: false });
    break;
  }
  case "reset": {
    step("Resetting the local database (all local data is lost)");
    compose(["down", "--volumes"], { check: false });
    compose(["up", "-d"]);
    await waitHealthy();
    info("Re-apply the schema with: pnpm db:migrate && pnpm db:seed");
    break;
  }
  case "psql": {
    compose(["exec", "postgres", "psql", "-U", user, "-d", database], { check: false });
    break;
  }
  default:
    die(`unknown command "${command}" (expected up|down|status|logs|reset|psql)`);
}

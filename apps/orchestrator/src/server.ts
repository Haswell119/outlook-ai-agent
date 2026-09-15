import pino from "pino";
import { buildApp } from "./app.js";
import { APP_VERSION, isMemoryDatabase, loadConfig } from "./config.js";
import { createContainer } from "./container.js";
import { seedDemo } from "./seed/demo.js";

const cfg = loadConfig();
const logger = pino({ level: cfg.LOG_LEVEL, ...(cfg.NODE_ENV === "development" ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } } : {}) });

const container = await createContainer(cfg, { logger });
if (isMemoryDatabase(cfg) && cfg.DEMO_SEED) {
  const r = await seedDemo(container);
  logger.info(r, "demo data seeded into memory repositories");
}

const app = await buildApp(container, { loggerInstance: logger });
try {
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  logger.info({ version: APP_VERSION, llm: `${container.deps.llm.name}/${container.deps.llm.model}`, db: isMemoryDatabase(cfg) ? "memory" : "postgres", auth: cfg.AUTH_MODE, graph: cfg.GRAPH_ENABLED }, `Outlook AI Orchestrator listening on http://${cfg.HOST}:${cfg.PORT}/api/v1`);
} catch (e) {
  logger.error(e, "failed to start");
  process.exit(1);
}

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down");
  await app.close();
  await container.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

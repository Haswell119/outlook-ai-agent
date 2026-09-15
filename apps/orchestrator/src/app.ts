import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { authPlugin } from "./auth/plugin.js";
import type { Container } from "./container.js";
import { errorHandler } from "./http/error-handler.js";
import { actionRoutes } from "./http/routes/actions.js";
import { adminRoutes } from "./http/routes/admin.js";
import { analysisRoutes } from "./http/routes/analysis.js";
import { auditRoutes } from "./http/routes/audit.js";
import { automationRoutes } from "./http/routes/automations.js";
import { complianceRoutes } from "./http/routes/compliance.js";
import { searchRoutes } from "./http/routes/search.js";
import { systemRoutes } from "./http/routes/system.js";

export interface AppOptions {
  /** Fastify logger config (object) or `false`; use `loggerInstance` to pass an existing pino logger. */
  logger?: boolean | Record<string, unknown>;
  loggerInstance?: FastifyBaseLogger;
}

/** Builds the Fastify app around a wired container (also used by route tests via `app.inject`). */
export async function buildApp(c: Container, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.loggerInstance ? { loggerInstance: opts.loggerInstance } : { logger: opts.logger ?? { level: c.cfg.LOG_LEVEL } }),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    requestIdHeader: "x-correlation-id",
    genReqId: () => randomUUID(),
  });

  // Accept `content-type: application/json` with an empty body (POST /automations/detect, approve…).
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-correlation-id", req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || c.cfg.CORS_ORIGINS.includes("*") || c.cfg.CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "accept-language", "x-user-email", "x-user-name", "x-user-roles", "x-correlation-id"],
    exposedHeaders: ["x-correlation-id", "content-disposition"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, { max: c.cfg.RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute", allowList: [], keyGenerator: (req) => req.headers["x-user-email"]?.toString() ?? req.ip });
  await app.register(authPlugin, c.cfg);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "not_found", message: `Route ${req.method} ${req.url} not found`, correlationId: req.id } }));

  await app.register(async (api) => {
    await systemRoutes(api, c);
    await analysisRoutes(api, c);
    await searchRoutes(api, c);
    await actionRoutes(api, c);
    await complianceRoutes(api, c);
    await automationRoutes(api, c);
    await auditRoutes(api, c);
    await adminRoutes(api, c);
  });

  return app;
}

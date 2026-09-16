import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { Routes } from "@oao/shared";
import { authPlugin, precomputeRegistrationPlugin } from "./auth/plugin.js";
import { APP_VERSION, trustProxyOption } from "./config.js";
import type { Container } from "./container.js";
import { errorHandler } from "./http/error-handler.js";
import { requestContext } from "./http/helpers.js";
import { actionRoutes } from "./http/routes/actions.js";
import { adminRoutes } from "./http/routes/admin.js";
import { analysisRoutes } from "./http/routes/analysis.js";
import { auditRoutes } from "./http/routes/audit.js";
import { automationRoutes } from "./http/routes/automations.js";
import { complianceRoutes } from "./http/routes/compliance.js";
import { searchRoutes } from "./http/routes/search.js";
import { systemRoutes } from "./http/routes/system.js";
import { routeLabel } from "./metrics.js";
import { buildOpenApiDocument } from "./openapi.js";

export interface AppOptions {
  /** Fastify logger config (object) or `false`; use `loggerInstance` to pass an existing pino logger. */
  logger?: boolean | Record<string, unknown>;
  loggerInstance?: FastifyBaseLogger;
}

/** Builds the Fastify app around a wired container (also used by route tests via `app.inject`). */
export async function buildApp(c: Container, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.loggerInstance ? { loggerInstance: opts.loggerInstance } : { logger: opts.logger ?? { level: c.cfg.LOG_LEVEL } }),
    bodyLimit: c.cfg.BODY_LIMIT_BYTES,
    trustProxy: trustProxyOption(c.cfg.TRUST_PROXY),
    // Hard bound on a single request; the LLM queue has its own, shorter, timeout.
    requestTimeout: c.cfg.REQUEST_TIMEOUT_MS,
    connectionTimeout: c.cfg.REQUEST_TIMEOUT_MS + 5_000,
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

  /* ------------------------------- metrics ------------------------------ */
  // Per-request duration/count by route & status. `onResponse` fires for errors too.
  app.addHook("onRequest", async (req) => {
    (req as { startedAt?: number }).startedAt = process.hrtime.bigint ? Number(process.hrtime.bigint() / 1_000_000n) : Date.now();
  });
  app.addHook("onResponse", async (req, reply) => {
    if (!c.cfg.METRICS_ENABLED) return;
    const started = (req as { startedAt?: number }).startedAt;
    const seconds = started ? Math.max(0, (Date.now() - started) / 1000) : (reply.elapsedTime ?? 0) / 1000;
    const labels = { method: req.method, route: routeLabel(req.routeOptions?.url, req.url), status: String(reply.statusCode) };
    c.metrics.httpRequests.inc(labels);
    c.metrics.httpDuration.observe(labels, seconds);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || c.cfg.CORS_ORIGINS.includes("*") || c.cfg.CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "accept-language", "x-user-email", "x-user-name", "x-user-roles", "x-correlation-id", "idempotency-key", "x-idempotency-key"],
    exposedHeaders: ["x-correlation-id", "content-disposition"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  /**
   * Auth is registered **before** the rate limiter on purpose: Fastify runs
   * `onRequest` hooks in plugin-registration order, so this is what makes
   * `request.user` available to `keyGenerator` below. With the two swapped the
   * limiter only ever saw an unauthenticated request.
   */
  await app.register(authPlugin, c.cfg);

  /**
   * Rate limiting **per identity**, not per IP: behind a corporate NAT or an
   * ingress, 50 users share one source address, so an IP-only limiter either
   * throttles everyone or protects no one.
   *
   * The key is the *authenticated* identity (or the source address on the
   * public probe routes) and never a request header: `x-user-email` is supplied
   * by the caller, so keying on it let anyone opt out of the limit by sending a
   * different value on every request. Requests that fail authentication never
   * reach this hook; they are throttled by `AuthFailureThrottle` instead.
   */
  await app.register(rateLimit, {
    max: c.cfg.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    allowList: [],
    keyGenerator: (req) => {
      const user = (req as { user?: { id?: string } }).user;
      return user?.id ? `u:${user.id}` : `ip:${req.ip}`;
    },
  });
  if (c.services.mailboxSync.enabled && c.cfg.GRAPH_AUTH_MODE === "obo") {
    // Remembers the caller's delegated token so the worker can sync their inbox later.
    await app.register(precomputeRegistrationPlugin, { register: (req) => c.services.mailboxSync.register(requestContext(req, c.cfg)) });
  }
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "not_found", message: `Route ${req.method} ${req.url} not found`, correlationId: req.id } }));

  /* -------------------------------- docs -------------------------------- */
  if (c.cfg.API_DOCS_ENABLED) {
    const [{ default: swagger }, { default: swaggerUi }] = await Promise.all([import("@fastify/swagger"), import("@fastify/swagger-ui")]);
    // `static` mode: the document comes from the shared zod contracts, so
    // documenting a route changes nothing about how it validates at runtime.
    await app.register(swagger, { mode: "static", specification: { document: buildOpenApiDocument() as never } });
    await app.register(swaggerUi, { routePrefix: `${Routes.features.replace("/config/features", "")}/docs`, uiConfig: { docExpansion: "list", deepLinking: true }, staticCSP: false });
  }

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

  app.log.debug({ version: APP_VERSION, docs: c.cfg.API_DOCS_ENABLED }, "routes registered");
  return app;
}

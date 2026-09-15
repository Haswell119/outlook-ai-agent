import type { FastifyInstance } from "fastify";
import { FeatureFlagsSchema, HealthSchema, Routes, UserIdentitySchema } from "@oao/shared";
import { APP_VERSION } from "../../config.js";
import type { Container } from "../../container.js";

export async function systemRoutes(app: FastifyInstance, c: Container) {
  app.get(Routes.health, async () => {
    const [db, llm] = await Promise.all([c.deps.repos.ping(2000), c.deps.llm.ping(2000)]);
    const checks = {
      database: { status: db.ok ? "ok" : "down", detail: db.detail },
      llm: { status: llm.ok ? "ok" : "degraded", detail: llm.detail },
      graph: { status: c.cfg.GRAPH_ENABLED ? "ok" : "degraded", detail: c.cfg.GRAPH_ENABLED ? "enabled" : "disabled (GRAPH_ENABLED=false) — client fallbacks" },
    } as const;
    const status = !db.ok ? "down" : !llm.ok ? "degraded" : "ok";
    return HealthSchema.parse({ status, checks, version: APP_VERSION, timestamp: new Date().toISOString() });
  });

  app.get(Routes.features, async () =>
    FeatureFlagsSchema.parse({ graphEnabled: c.cfg.GRAPH_ENABLED, embeddingsEnabled: c.services.indexEmails.embeddingsAvailable, llmProvider: c.deps.llm.name, llmModel: c.deps.llm.model, authMode: c.cfg.AUTH_MODE, version: APP_VERSION }),
  );

  app.get(Routes.me, async (req) => UserIdentitySchema.parse({ id: req.user.id, email: req.user.email, displayName: req.user.displayName, tenantId: req.user.tenantId, roles: req.user.roles }));
}

import type { FastifyInstance } from "fastify";
import { Routes } from "@oao/shared";
import { requireRole } from "../../auth/plugin.js";
import type { Container } from "../../container.js";
import { systemStatus } from "./system.js";

export async function adminRoutes(app: FastifyInstance, c: Container) {
  app.get(Routes.adminPolicy, { preHandler: requireRole("admin", "compliance") }, async () => c.services.policy.get());
  app.put(Routes.adminPolicy, { preHandler: requireRole("admin") }, async (req) => c.services.policy.put(req.user, req.body));
  app.get(Routes.adminUsers, { preHandler: requireRole("admin") }, async () => c.services.users.list());

  /**
   * Runtime status for the admin dashboard: queue depth, circuit state, cache
   * hit counters, worker/sync state and uptime. Read-only.
   */
  app.get(Routes.adminSystem, { preHandler: requireRole("admin") }, async (req) => {
    const target = (req.query as { userId?: string }).userId ?? req.user.id;
    return systemStatus(c, target);
  });
}

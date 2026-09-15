import type { FastifyInstance } from "fastify";
import { Routes } from "@oao/shared";
import { requireRole } from "../../auth/plugin.js";
import type { Container } from "../../container.js";

export async function adminRoutes(app: FastifyInstance, c: Container) {
  app.get(Routes.adminPolicy, { preHandler: requireRole("admin", "compliance") }, async () => c.services.policy.get());
  app.put(Routes.adminPolicy, { preHandler: requireRole("admin") }, async (req) => c.services.policy.put(req.user, req.body));
  app.get(Routes.adminUsers, { preHandler: requireRole("admin") }, async () => c.services.users.list());
}

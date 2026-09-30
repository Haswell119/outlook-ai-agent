import type { FastifyInstance } from "fastify";
import { MAILBOX_IMPORT_MAX_BATCH_BYTES, MailboxImportRequestSchema, Routes } from "@oao/shared";
import { requireRole } from "../../auth/plugin.js";
import type { Container } from "../../container.js";
import { parseBody } from "../helpers.js";
import { systemStatus } from "./system.js";

/** Base64 inflates the files by a third; the JSON envelope and names fit in the extra MiB. */
export const MAILBOX_IMPORT_BODY_LIMIT = Math.ceil((MAILBOX_IMPORT_MAX_BATCH_BYTES * 4) / 3) + 1024 * 1024;

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

  /**
   * Mailbox import (`.eml` / `.msg`) for deployments without Graph — see
   * `MailboxImportService`. The only route with a body limit above
   * `BODY_LIMIT_BYTES`, and its own rate-limit bucket so a long import never
   * throttles the rest of the dashboard.
   */
  app.post(
    Routes.mailboxImport,
    { preHandler: requireRole("admin"), bodyLimit: MAILBOX_IMPORT_BODY_LIMIT, config: { rateLimit: { max: c.cfg.RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } },
    async (req) => c.services.mailboxImport.import(req.user, parseBody(MailboxImportRequestSchema, req.body)),
  );
}

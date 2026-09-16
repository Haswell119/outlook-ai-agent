import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuditQuerySchema, FeedbackRequestSchema, Routes } from "@oao/shared";
import { requireRole } from "../../auth/plugin.js";
import type { Container } from "../../container.js";
import { coerceQuery, parseBody, requestContext } from "../helpers.js";

const StatsQuerySchema = z.object({ from: z.string().optional(), to: z.string().optional() });

export async function auditRoutes(app: FastifyInstance, c: Container) {
  app.get(Routes.audit, async (req) => c.services.audit.query(req.user, parseBody(AuditQuerySchema, coerceQuery(req.query as Record<string, unknown>, ["page", "pageSize"]))));

  app.get(Routes.auditStats, { preHandler: requireRole("admin", "compliance") }, async (req) => {
    const q = parseBody(StatsQuerySchema, req.query);
    const to = q.to ?? new Date().toISOString();
    const from = q.from ?? new Date(Date.parse(to) - 7 * 86_400_000).toISOString();
    return c.services.audit.stats(from, to);
  });

  app.get(Routes.auditExport, { preHandler: requireRole("admin", "compliance") }, async (req, reply) => {
    const q = parseBody(AuditQuerySchema, coerceQuery(req.query as Record<string, unknown>, ["page", "pageSize"]));
    const { page: _p, pageSize: _s, ...filters } = q;
    // Streamed with keyset pagination: a two-year export never buffers in memory.
    const stream = Readable.from(c.services.audit.streamCsv(req.user, filters, { pageSize: 500 }));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .header("cache-control", "no-store")
      .send(stream);
  });

  app.get(Routes.auditEvent(":id"), async (req) => c.services.audit.get(req.user, (req.params as { id: string }).id));

  app.post(Routes.feedback, async (req, reply) => reply.status(201).send(await c.services.feedback.submit(requestContext(req, c.cfg), parseBody(FeedbackRequestSchema, req.body))));
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ComplianceCheckRequestSchema, EscalationRequestSchema, PhishingCheckRequestSchema, Routes } from "@oao/shared";
import { requireRole } from "../../auth/plugin.js";
import type { Container } from "../../container.js";
import { parseBody, requestContext } from "../helpers.js";

/** Not in the shared contract (yet): decision body for POST /compliance/escalations/:id/decision. */
export const EscalationDecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().optional() });

export async function complianceRoutes(app: FastifyInstance, c: Container) {
  app.post(Routes.complianceCheck, async (req) => {
    const body = parseBody(ComplianceCheckRequestSchema, req.body);
    return c.services.compliance.check(requestContext(req, c.cfg, body.language), body);
  });
  app.post(Routes.phishingCheck, async (req) => c.services.compliance.phishing(requestContext(req, c.cfg), parseBody(PhishingCheckRequestSchema, req.body).email));

  app.post(Routes.escalations, async (req, reply) => {
    const body = parseBody(EscalationRequestSchema, req.body);
    const e = await c.services.escalations.create(requestContext(req, c.cfg), body);
    return reply.status(201).send(e);
  });
  app.get(Routes.escalations, async (req) => {
    const status = (req.query as { status?: "pending" | "approved" | "rejected" }).status;
    return c.services.escalations.list(requestContext(req, c.cfg), status);
  });
  app.get(Routes.escalation(":id"), async (req) => c.services.escalations.get(requestContext(req, c.cfg), (req.params as { id: string }).id));
  app.post(Routes.escalationDecision(":id"), { preHandler: requireRole("compliance", "admin") }, async (req) => {
    const body = parseBody(EscalationDecisionSchema, req.body);
    return c.services.escalations.decide(requestContext(req, c.cfg), (req.params as { id: string }).id, body.decision, body.comment);
  });
}

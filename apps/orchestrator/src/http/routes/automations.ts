import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AutomationDecisionRequestSchema, Routes, SimulateAutomationRequestSchema, UserActionEventSchema } from "@oao/shared";
import type { Container } from "../../container.js";
import { AutomationPatchSchema } from "../../services/AutomationCoachService.js";
import { parseBody, requestContext } from "../helpers.js";

/** Accepts `{ events: [...] }` or a bare array of UserActionEvent. */
const ObserveSchema = z.union([z.object({ events: z.array(UserActionEventSchema).min(1).max(500) }), z.array(UserActionEventSchema).min(1).max(500)]).transform((v) => (Array.isArray(v) ? v : v.events));

export async function automationRoutes(app: FastifyInstance, c: Container) {
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.post(Routes.automationsObserve, async (req, reply) => reply.status(202).send(await c.services.automations.observe(requestContext(req, c.cfg), parseBody(ObserveSchema, req.body))));
  app.post(Routes.automationDetect, async (req) => c.services.automations.detect(requestContext(req, c.cfg)));
  app.get(Routes.automations, async (req) => c.services.automations.list(requestContext(req, c.cfg), (req.query as { all?: string }).all === "true"));
  app.get(Routes.automation(":id"), async (req) => c.services.automations.get(requestContext(req, c.cfg), id(req)));
  app.patch(Routes.automation(":id"), async (req) => c.services.automations.update(requestContext(req, c.cfg), id(req), parseBody(AutomationPatchSchema, req.body)));
  app.post(Routes.automationSimulate(":id"), async (req) => c.services.automations.simulate(requestContext(req, c.cfg), id(req), parseBody(SimulateAutomationRequestSchema, req.body).sampleSize));
  app.post(Routes.automationApprove(":id"), async (req) => c.services.automations.approve(requestContext(req, c.cfg), id(req), parseBody(AutomationDecisionRequestSchema, req.body).comment));
  app.post(Routes.automationReject(":id"), async (req) => c.services.automations.reject(requestContext(req, c.cfg), id(req), parseBody(AutomationDecisionRequestSchema, req.body).comment));
}

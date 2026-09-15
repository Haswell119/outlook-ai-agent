import type { FastifyInstance } from "fastify";
import { ApproveActionsRequestSchema, ProposeActionsRequestSchema, ReportActionResultRequestSchema, Routes } from "@oao/shared";
import type { Container } from "../../container.js";
import { parseBody, requestContext } from "../helpers.js";

export async function actionRoutes(app: FastifyInstance, c: Container) {
  app.post(Routes.proposeActions, async (req) => {
    const body = parseBody(ProposeActionsRequestSchema, req.body);
    return c.services.actions.propose(requestContext(req, c.cfg, body.language), body);
  });
  app.post(Routes.approveActions, async (req) => c.services.actions.approve(requestContext(req, c.cfg), parseBody(ApproveActionsRequestSchema, req.body)));
  app.post(Routes.reportActionResult(":id"), async (req) => {
    const id = (req.params as { id: string }).id;
    const body = parseBody(ReportActionResultRequestSchema, { actionId: id, ...((req.body as object) ?? {}) });
    return c.services.actions.report(requestContext(req, c.cfg), id, body);
  });
}

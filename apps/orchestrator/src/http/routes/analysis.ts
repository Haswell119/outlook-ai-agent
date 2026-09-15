import type { FastifyInstance } from "fastify";
import { AnalyzeEmailRequestSchema, AnalyzeThreadRequestSchema, DraftReplyRequestSchema, Routes } from "@oao/shared";
import type { Container } from "../../container.js";
import { parseBody, requestContext } from "../helpers.js";

export async function analysisRoutes(app: FastifyInstance, c: Container) {
  app.post(Routes.analyzeEmail, async (req) => {
    const body = parseBody(AnalyzeEmailRequestSchema, req.body);
    return c.services.analyzeEmail.analyze(requestContext(req, c.cfg, body.language), body);
  });
  app.post(Routes.analyzeThread, async (req) => {
    const body = parseBody(AnalyzeThreadRequestSchema, req.body);
    return c.services.synthesizeThread.synthesize(requestContext(req, c.cfg, body.language), body);
  });
  app.post(Routes.draftReply, async (req) => {
    const body = parseBody(DraftReplyRequestSchema, req.body);
    return c.services.draftReply.draft(requestContext(req, c.cfg, body.language), body);
  });
}

import type { FastifyInstance } from "fastify";
import { ChatRequestSchema, IndexEmailsRequestSchema, Routes, SearchRequestSchema } from "@oao/shared";
import type { Container } from "../../container.js";
import { coerceQuery, parseBody, requestContext } from "../helpers.js";

export async function searchRoutes(app: FastifyInstance, c: Container) {
  app.post(Routes.search, async (req) => c.services.search.search(requestContext(req, c.cfg), parseBody(SearchRequestSchema, req.body)));
  app.get(Routes.search, async (req) => c.services.search.search(requestContext(req, c.cfg), parseBody(SearchRequestSchema, coerceQuery(req.query as Record<string, unknown>, ["limit"]))));
  app.post(Routes.chat, async (req) => {
    const body = parseBody(ChatRequestSchema, req.body);
    return c.services.chat.chat(requestContext(req, c.cfg, body.language), body);
  });
  app.get(Routes.chatSession(":id"), async (req) => c.services.chat.getSession(requestContext(req, c.cfg), (req.params as { id: string }).id));
  app.post(Routes.indexEmails, async (req) => c.services.indexEmails.index(requestContext(req, c.cfg), parseBody(IndexEmailsRequestSchema, req.body).emails));
}

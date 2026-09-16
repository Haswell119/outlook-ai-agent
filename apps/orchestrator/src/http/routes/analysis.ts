import type { FastifyInstance } from "fastify";
import { AnalyzeEmailRequestSchema, AnalyzeThreadRequestSchema, DailyBriefRequestSchema, DraftReplyRequestSchema, Routes } from "@oao/shared";
import type { Container } from "../../container.js";
import { AppError } from "../../errors.js";
import { hasRole } from "../../auth/identity.js";
import { parseBody, requestContext } from "../helpers.js";

export async function analysisRoutes(app: FastifyInstance, c: Container) {
  app.post(Routes.analyzeEmail, async (req) => {
    const body = parseBody(AnalyzeEmailRequestSchema, req.body);
    return c.services.analyzeEmail.analyze(requestContext(req, c.cfg, body.language), body);
  });

  /**
   * `GET /analyze/email/:id` — the precomputed or cached analysis of a known
   * email. **Never calls the model**: it answers in a few milliseconds or 404s.
   *
   * 404 semantics for the add-in: "nothing computed for this email (yet)" —
   * fall back to `POST /analyze/email` with the content Office.js already has.
   * A 404 is normal for a brand-new email, or when precomputation is off.
   */
  // Built from `Routes.analyzeEmail` on purpose: `Routes.analysisByEmail()` is a
  // *client* helper that URL-encodes its argument, so it cannot express a param.
  app.get(`${Routes.analyzeEmail}/:emailId`, async (req) => {
    const { emailId } = req.params as { emailId: string };
    // Fastify already percent-decodes path params; decoding again would corrupt
    // a Graph id that legitimately contains a "%".
    return c.services.analyzeEmail.getStored(requestContext(req, c.cfg), emailId);
  });

  app.post(Routes.analyzeThread, async (req) => {
    const body = parseBody(AnalyzeThreadRequestSchema, req.body);
    return c.services.synthesizeThread.synthesize(requestContext(req, c.cfg, body.language), body);
  });

  app.post(Routes.draftReply, async (req) => {
    const body = parseBody(DraftReplyRequestSchema, req.body);
    return c.services.draftReply.draft(requestContext(req, c.cfg, body.language), body);
  });

  /* ------------------------------ daily brief --------------------------- */

  /** Stored brief for a date (default: today in `TZ`). 404 when none was generated. */
  app.get(Routes.dailyBrief, async (req) => {
    const ctx = requestContext(req, c.cfg);
    const date = (req.query as { date?: string }).date ?? c.services.dailyBrief.today();
    const brief = await c.services.dailyBrief.getStored(ctx.user.id, date);
    if (!brief) throw AppError.notFound(`Daily brief for ${date}`);
    return brief;
  });

  /** Generate on demand (`refresh: true` forces a rebuild). */
  app.post(Routes.dailyBrief, async (req) => {
    const body = parseBody(DailyBriefRequestSchema, req.body ?? {});
    const ctx = requestContext(req, c.cfg, body.language);
    return c.services.dailyBrief.generate(ctx, { date: body.date, refresh: body.refresh });
  });

  /* ----------------------------- mailbox sync --------------------------- */

  /** Precomputation status for the caller (admin may pass `?userId=`). */
  app.get(Routes.mailboxSync, async (req) => {
    const ctx = requestContext(req, c.cfg);
    const target = (req.query as { userId?: string }).userId;
    if (target && target !== ctx.user.id && !hasRole(ctx.user, "admin")) throw AppError.forbidden("Only an admin can read another user's sync status");
    return c.services.mailboxSync.status(target ?? ctx.user.id);
  });

  /** Trigger a sync now for the caller (admin may pass `?userId=`). */
  app.post(Routes.mailboxSync, async (req, reply) => {
    const ctx = requestContext(req, c.cfg);
    const target = (req.query as { userId?: string }).userId;
    if (target && target !== ctx.user.id && !hasRole(ctx.user, "admin")) throw AppError.forbidden("Only an admin can trigger another user's sync");
    const userId = target ?? ctx.user.id;
    const result = await c.services.mailboxSync.syncUser(userId, {
      // The caller's own token lets us sync without waiting for a cached one.
      userToken: !target || target === ctx.user.id ? ctx.user.token : undefined,
      userEmail: !target || target === ctx.user.id ? ctx.user.email : target,
      priority: "interactive",
    });
    const status = await c.services.mailboxSync.status(userId);
    return reply.status(202).send({ ...status, result });
  });
}

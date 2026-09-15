import type { FeedbackRequest } from "@oao/shared";
import { AppError } from "../errors.js";
import { newId, nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";

export class FeedbackService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async submit(ctx: RequestContext, req: FeedbackRequest): Promise<{ id: string }> {
    const event = await this.deps.repos.audit.get(req.auditId);
    if (!event) throw AppError.notFound("Audit event");
    const id = newId();
    await this.deps.repos.feedback.save({ id, auditId: req.auditId, userId: ctx.user.id, rating: req.rating, comment: req.comment, createdAt: nowIso() });
    void this.audit; // feedback is stored in its own table; no separate audit row needed
    return { id };
  }
}

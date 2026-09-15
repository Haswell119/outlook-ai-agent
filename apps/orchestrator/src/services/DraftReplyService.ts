import type { DraftReply, DraftReplyRequest } from "@oao/shared";
import { DraftReplySchema } from "@oao/shared";
import { buildDraftReplyPrompt, DraftReplyLlmSchema, type DraftReplyLlm } from "../domain/prompts/index.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";

export class DraftReplyService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async draft(ctx: RequestContext, req: DraftReplyRequest): Promise<DraftReply> {
    const { user, language, correlationId } = ctx;
    const prompt = buildDraftReplyPrompt({ email: req.email, thread: req.thread, intent: req.intent, tone: req.tone, instructions: req.instructions, language, senderName: user.displayName });
    const result = await completeStructured(this.deps.llm, DraftReplyLlmSchema, prompt, () => fallbackDraft(req, language, user.displayName), this.deps.logger);
    const confidence = result.degraded ? Math.min(result.data.confidence, DEGRADED_CONFIDENCE) : result.data.confidence;
    const event = await this.audit.record({
      user,
      type: "draft_reply_generated",
      source: { label: req.email.subject || "(no subject)", emailId: req.email.id, conversationId: req.email.conversationId, counterpart: req.email.from?.address },
      riskLevel: "low",
      approvalStatus: "pending", // the user decides whether to send — the AI never sends
      confidence,
      model: result.model,
      latencyMs: result.latencyMs,
      correlationId,
      details: { ...this.audit.hashes(result.promptText, result.raw), intent: req.intent, tone: req.tone, degraded: result.degraded, repaired: result.repaired, bodyChars: result.data.body.length },
    });
    if (result.degraded) await this.audit.record({ user, type: "error", source: { label: req.email.subject, emailId: req.email.id }, correlationId, details: { stage: "draft_reply", error: result.error } });
    return DraftReplySchema.parse({ subject: result.data.subject, body: result.data.body, language, confidence, auditId: event.id, model: result.model });
  }
}

function fallbackDraft(req: DraftReplyRequest, language: "fr" | "en", name?: string): DraftReplyLlm {
  const fr = language === "fr";
  const who = req.email.from?.name?.split(" ")[0];
  const subject = /^(re|tr|fw|fwd)\s*:/i.test(req.email.subject) ? req.email.subject : `${fr ? "RE" : "Re"}: ${req.email.subject}`;
  const body = fr
    ? `Bonjour${who ? ` ${who}` : ""},\n\nMerci pour votre message concernant « ${req.email.subject} ». ${req.instructions ?? "Nous l'avons bien reçu et reviendrons vers vous rapidement."}\n\nMeilleures salutations,\n${name ?? ""}`.trim()
    : `Dear${who ? ` ${who}` : " Sir or Madam"},\n\nThank you for your message regarding "${req.email.subject}". ${req.instructions ?? "We have received it and will revert shortly."}\n\nKind regards,\n${name ?? ""}`.trim();
  return { subject, body, language, confidence: DEGRADED_CONFIDENCE };
}

import type { DraftReply, DraftReplyRequest } from "@oao/shared";
import { DraftReplySchema } from "@oao/shared";
import { draftCacheKey } from "../domain/cacheKey.js";
import { buildDraftReplyPrompt, DraftReplyLlmSchema, type DraftReplyLlm, type PromptStats } from "../domain/prompts/index.js";
import type { AiCacheService } from "./AiCacheService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";

interface DraftPayload {
  data: DraftReplyLlm;
  stats: PromptStats;
  degraded: boolean;
  repaired: boolean;
  error?: string;
  latencyMs: number;
  promptHashes: Record<string, unknown>;
}

/**
 * Reply drafting. Cached **per intent, tone and instructions**: clicking
 * "Accept" then "Decline" produces two calls, but clicking "Accept" twice (or
 * reopening the pane) produces one. The draft is never sent by the AI.
 */
export class DraftReplyService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly cache: AiCacheService,
  ) {}

  async draft(ctx: RequestContext, req: DraftReplyRequest): Promise<DraftReply> {
    const { user, language, correlationId } = ctx;
    const budget = { maxChars: this.deps.cfg.LLM_INPUT_MAX_CHARS, threadMaxMessages: this.deps.cfg.THREAD_MAX_MESSAGES };
    const key = draftCacheKey({
      email: req.email,
      intent: req.intent,
      tone: req.tone,
      instructions: req.instructions,
      language,
      senderName: user.displayName,
      promptVersion: this.deps.cfg.PROMPT_VERSION,
      maxChars: budget.maxChars,
    });

    const cached = await this.cache.through<DraftPayload>(user.id, "draft", key, { emailId: req.email.id, conversationId: req.email.conversationId }, async () => {
      const prompt = buildDraftReplyPrompt({ email: req.email, thread: req.thread, intent: req.intent, tone: req.tone, instructions: req.instructions, language, senderName: user.displayName }, budget);
      const result = await completeStructured(this.deps.llm, DraftReplyLlmSchema, { ...prompt.request, userId: user.id, priority: "interactive" }, () => fallbackDraft(req, language, user.displayName), this.deps.logger);
      return {
        value: { data: result.data, stats: prompt.stats, degraded: result.degraded, repaired: result.repaired, error: result.error, latencyMs: result.latencyMs, promptHashes: this.audit.hashes(result.promptText, result.raw) },
        model: result.model,
        cacheable: !result.degraded,
        origin: result.degraded ? "heuristic" : "llm",
      };
    });

    const payload = cached.value;
    const confidence = payload.degraded ? Math.min(payload.data.confidence, DEGRADED_CONFIDENCE) : payload.data.confidence;
    const event = await this.audit.record({
      user,
      type: "draft_reply_generated",
      source: { label: req.email.subject || "(no subject)", emailId: req.email.id, conversationId: req.email.conversationId, counterpart: req.email.from?.address },
      riskLevel: "low",
      approvalStatus: "pending", // the user decides whether to send — the AI never sends
      confidence,
      model: cached.model,
      latencyMs: cached.source === "llm" ? payload.latencyMs : 0,
      correlationId,
      details: {
        ...payload.promptHashes,
        intent: req.intent,
        tone: req.tone,
        cached: cached.source !== "llm",
        cacheSource: cached.source,
        coalesced: cached.coalesced,
        promptStats: { tokens: payload.stats.tokens, chars: payload.stats.chars, rawChars: payload.stats.rawChars, savedRatio: payload.stats.savedRatio },
        degraded: payload.degraded,
        repaired: payload.repaired,
        bodyChars: payload.data.body.length,
      },
    });
    if (payload.degraded && cached.source === "llm") await this.audit.record({ user, type: "error", source: { label: req.email.subject, emailId: req.email.id }, correlationId, details: { stage: "draft_reply", error: payload.error } });
    return DraftReplySchema.parse({ subject: payload.data.subject, body: payload.data.body, language, confidence, auditId: event.id, model: cached.model });
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

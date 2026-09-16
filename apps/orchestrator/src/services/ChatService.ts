import type { ChatMessage, ChatRequest, ChatResponse, SearchSource } from "@oao/shared";
import { ChatResponseSchema, safeExternalLink } from "@oao/shared";
import { hasRole } from "../auth/identity.js";
import { buildChatPrompt, ChatAnswerLlmSchema, type ChatAnswerLlm } from "../domain/prompts/index.js";
import { AppError } from "../errors.js";
import { bestExcerpt, normalizeWhitespace, truncate } from "../util/text.js";
import { newId, nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured, DEGRADED_CONFIDENCE } from "./llm-helpers.js";
import type { SearchService } from "./SearchService.js";

const HISTORY_TURNS = 10;
const RETRIEVAL_LIMIT = 6;

export class ChatService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly search: SearchService,
  ) {}

  async chat(ctx: RequestContext, req: ChatRequest): Promise<ChatResponse> {
    const { user, language, correlationId } = ctx;
    const repo = this.deps.repos.chat;
    const now = nowIso();

    let session = req.sessionId ? await repo.getSession(req.sessionId) : undefined;
    if (req.sessionId && (!session || session.userId !== user.id)) throw AppError.notFound("Chat session");
    if (!session) {
      session = { id: newId(), userId: user.id, title: truncate(req.message, 80), createdAt: now, updatedAt: now };
      await repo.createSession(session);
    }
    const history = await repo.listMessages(session.id, HISTORY_TURNS);

    // Retrieval, scoped; the current email (if any) is always source [1].
    const { results, mode } = await this.search.retrieve(user.id, req.message, { conversationId: req.scope.conversationId, folder: req.scope.folder, from: req.scope.from, to: req.scope.to }, RETRIEVAL_LIMIT);
    const sources: SearchSource[] = [];
    if (req.currentEmail) {
      const e = req.currentEmail;
      sources.push({ emailId: e.id, conversationId: e.conversationId, subject: e.subject, from: e.from?.name ?? e.from?.address, date: e.receivedAt ?? e.sentAt, relevance: 1, excerpt: bestExcerpt(e.body, req.message, 300), webLink: safeExternalLink(e.webLink) });
    }
    for (const r of results) if (!sources.some((s) => s.emailId === r.emailId)) sources.push(r);

    const prompt = buildChatPrompt({ question: req.message, sources, history, currentEmail: req.currentEmail, language });
    const result = await completeStructured(this.deps.llm, ChatAnswerLlmSchema, prompt, () => fallbackAnswer(sources, language), this.deps.logger);
    const d = result.data;

    const usedIds = Array.from(new Set(d.sourceIds.filter((n) => n >= 1 && n <= sources.length)));
    // Also honour inline [n] citations the model wrote in the text.
    for (const m of d.answer.matchAll(/\[(\d+)\]/g)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= sources.length && !usedIds.includes(n)) usedIds.push(n);
    }
    const usedSources = usedIds.map((n) => sources[n - 1]!).filter(Boolean);
    const evidenceIdx = d.evidenceSourceId && d.evidenceSourceId >= 1 && d.evidenceSourceId <= sources.length ? d.evidenceSourceId : usedIds[0];
    const evidenceSource = evidenceIdx ? sources[evidenceIdx - 1] : undefined;
    let evidence: ChatResponse["evidence"];
    if (evidenceSource) {
      const fullText = req.currentEmail && req.currentEmail.id === evidenceSource.emailId ? normalizeWhitespace(req.currentEmail.body) : evidenceSource.excerpt;
      const quote = d.quote && fullText.toLowerCase().includes(d.quote.toLowerCase().slice(0, 40)) ? d.quote : bestExcerpt(fullText, req.message, 150);
      evidence = { emailId: evidenceSource.emailId, subject: evidenceSource.subject, quote: truncate(quote, 400), author: evidenceSource.from, date: evidenceSource.date, webLink: evidenceSource.webLink };
    }
    const confidence = result.degraded ? Math.min(d.confidence, DEGRADED_CONFIDENCE) : sources.length ? d.confidence : Math.min(d.confidence, 0.4);

    const event = await this.audit.record({
      user,
      type: "chat_answered",
      source: usedSources[0] ? { label: usedSources[0].subject, emailId: usedSources[0].emailId, conversationId: usedSources[0].conversationId } : req.currentEmail ? { label: req.currentEmail.subject, emailId: req.currentEmail.id } : undefined,
      approvalStatus: "auto_approved",
      confidence,
      model: result.model,
      latencyMs: result.latencyMs,
      correlationId,
      details: { ...this.audit.hashes(result.promptText, result.raw), sessionId: session.id, retrievalMode: mode, retrieved: sources.length, cited: usedSources.map((s) => s.emailId), degraded: result.degraded, questionHash: this.audit.hashes(req.message, "").promptHash },
    });

    const userMsg: ChatMessage = { role: "user", content: req.message, createdAt: now };
    const assistantMsg: ChatMessage & { auditId?: string } = { role: "assistant", content: d.answer, createdAt: nowIso(), sources: usedSources, auditId: event.id };
    await repo.appendMessage(session.id, userMsg);
    await repo.appendMessage(session.id, assistantMsg);
    await repo.touch(session.id, assistantMsg.createdAt);

    return ChatResponseSchema.parse({ sessionId: session.id, answer: d.answer, headline: d.headline, sources: usedSources, evidence, confidence, auditId: event.id, model: result.model });
  }

  async getSession(ctx: RequestContext, sessionId: string): Promise<{ sessionId: string; title?: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }> {
    const session = await this.deps.repos.chat.getSession(sessionId);
    if (!session || (session.userId !== ctx.user.id && !hasRole(ctx.user, "admin"))) throw AppError.notFound("Chat session");
    const messages = await this.deps.repos.chat.listMessages(sessionId, 200);
    return { sessionId: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messages };
  }
}

function fallbackAnswer(sources: SearchSource[], language: "fr" | "en"): ChatAnswerLlm {
  if (!sources.length) {
    return { answer: language === "fr" ? "Je n'ai trouvé aucun email correspondant à votre question dans les emails indexés." : "I could not find any email matching your question in the indexed emails.", sourceIds: [], confidence: DEGRADED_CONFIDENCE };
  }
  const list = sources.slice(0, 3).map((s, i) => `[${i + 1}] ${s.subject} (${s.from ?? "?"}, ${s.date?.slice(0, 10) ?? "?"})`).join("; ");
  return {
    headline: language === "fr" ? "Résultats trouvés (mode dégradé)" : "Results found (degraded mode)",
    answer: language === "fr" ? `Le modèle IA est indisponible ; voici les emails les plus pertinents : ${list}.` : `The AI model is unavailable; here are the most relevant emails: ${list}.`,
    sourceIds: sources.slice(0, 3).map((_, i) => i + 1),
    evidenceSourceId: 1,
    quote: sources[0]?.excerpt,
    confidence: DEGRADED_CONFIDENCE,
  };
}

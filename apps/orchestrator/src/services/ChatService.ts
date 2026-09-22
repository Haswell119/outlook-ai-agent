import type { ChatMessage, ChatRequest, ChatResponse, SearchSource } from "@oao/shared";
import { ChatResponseSchema, safeExternalLink } from "@oao/shared";
import { hasRole } from "../auth/identity.js";
import { buildChatPrompt, ChatAnswerLlmSchema, type ChatAnswerLlm } from "../domain/prompts/index.js";
import { AppError } from "../errors.js";
import { bestExcerpt, normalizeWhitespace, queryTerms, tokenize, truncate } from "../util/text.js";
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

    /* ---------------------------- retrieval ---------------------------- */
    // Two scopes. `conversation` (a conversationId is given): the opened email
    // is what the question is about, so it is always source [1]. `mailbox`
    // (no conversationId — the add-in's "All emails"): the retrieval results
    // come first and the opened email is only appended, ranked by how much it
    // actually matches the question. Forcing it to [1] with relevance 1 is what
    // made every mailbox-wide answer stick to the email that happened to be open.
    const scope: NonNullable<ChatResponse["retrieval"]>["scope"] = req.scope.conversationId ? "conversation" : "mailbox";
    const { results, mode } = await this.search.retrieve(user.id, req.message, { conversationId: req.scope.conversationId, folder: req.scope.folder, from: req.scope.from, to: req.scope.to }, RETRIEVAL_LIMIT);
    const indexedEmails = await this.deps.repos.emailIndex.count(user.id).catch(() => 0);
    const sources: SearchSource[] = [];
    const current = req.currentEmail;
    const currentSource = (relevance: number): SearchSource | undefined =>
      current ? { emailId: current.id, conversationId: current.conversationId, subject: current.subject, from: current.from?.name ?? current.from?.address, date: current.receivedAt ?? current.sentAt, relevance, excerpt: bestExcerpt(current.body, req.message, 300), webLink: safeExternalLink(current.webLink) } : undefined;
    if (current && scope === "conversation") sources.push(currentSource(1)!);
    for (const r of results) if (!sources.some((s) => s.emailId === r.emailId)) sources.push(r);
    if (current && scope === "mailbox" && !sources.some((s) => s.emailId === current.id)) sources.push(currentSource(termOverlap(req.message, `${current.subject}\n${current.body}`))!);
    const retrieval: NonNullable<ChatResponse["retrieval"]> = { scope, mode: results.length ? mode : "none", indexedEmails, matched: results.length };

    /* ------------------------------ answer ----------------------------- */
    let d: ChatAnswerLlm;
    let result: Awaited<ReturnType<typeof completeStructured<ChatAnswerLlm>>> | undefined;
    if (!sources.length) {
      // Nothing to reason about: the model would only be asked to say "no
      // source" in nicer words. Skip the call (AI-load) and say it plainly,
      // with the reason (empty index vs. no match) so the user can act on it.
      d = noSourcesAnswer(indexedEmails, language);
      retrieval.modelCallSkipped = true;
      this.deps.logger.info({ indexedEmails, scope }, "chat: no source retrieved, model call skipped");
    } else {
      const prompt = buildChatPrompt({ question: req.message, sources, history, currentEmail: current, language, scope, indexedEmails });
      result = await completeStructured(this.deps.llm, ChatAnswerLlmSchema, prompt, () => fallbackAnswer(sources, language), this.deps.logger);
      d = result.data;
    }

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
      const fullText = current && current.id === evidenceSource.emailId ? normalizeWhitespace(current.body) : evidenceSource.excerpt;
      const quote = d.quote && fullText.toLowerCase().includes(d.quote.toLowerCase().slice(0, 40)) ? d.quote : bestExcerpt(fullText, req.message, 150);
      evidence = { emailId: evidenceSource.emailId, subject: evidenceSource.subject, quote: truncate(quote, 400), author: evidenceSource.from, date: evidenceSource.date, webLink: evidenceSource.webLink };
    }
    const degraded = result?.degraded ?? false;
    const confidence = degraded ? Math.min(d.confidence, DEGRADED_CONFIDENCE) : sources.length ? d.confidence : Math.min(d.confidence, 0.4);
    const model = result?.model ?? "no-retrieval";

    const event = await this.audit.record({
      user,
      type: "chat_answered",
      source: usedSources[0] ? { label: usedSources[0].subject, emailId: usedSources[0].emailId, conversationId: usedSources[0].conversationId } : current ? { label: current.subject, emailId: current.id } : undefined,
      approvalStatus: "auto_approved",
      confidence,
      model,
      latencyMs: result?.latencyMs ?? 0,
      correlationId,
      details: { ...(result ? this.audit.hashes(result.promptText, result.raw) : {}), sessionId: session.id, scope, retrievalMode: retrieval.mode, indexedEmails, retrieved: sources.length, matched: results.length, cited: usedSources.map((s) => s.emailId), degraded, modelCallSkipped: retrieval.modelCallSkipped ?? false, questionHash: this.audit.hashes(req.message, "").promptHash },
    });

    const userMsg: ChatMessage = { role: "user", content: req.message, createdAt: now };
    const assistantMsg: ChatMessage & { auditId?: string } = { role: "assistant", content: d.answer, createdAt: nowIso(), sources: usedSources, auditId: event.id };
    await repo.appendMessage(session.id, userMsg);
    await repo.appendMessage(session.id, assistantMsg);
    await repo.touch(session.id, assistantMsg.createdAt);

    return ChatResponseSchema.parse({ sessionId: session.id, answer: d.answer, headline: d.headline, sources: usedSources, evidence, confidence, auditId: event.id, model, retrieval });
  }

  async getSession(ctx: RequestContext, sessionId: string): Promise<{ sessionId: string; title?: string; createdAt: string; updatedAt: string; messages: ChatMessage[] }> {
    const session = await this.deps.repos.chat.getSession(sessionId);
    if (!session || (session.userId !== ctx.user.id && !hasRole(ctx.user, "admin"))) throw AppError.notFound("Chat session");
    const messages = await this.deps.repos.chat.listMessages(sessionId, 200);
    return { sessionId: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messages };
  }
}

/**
 * Share of the question's terms found in the text (0..1, crude prefix stemming),
 * used to rank the opened email among mailbox-wide results instead of forcing it first.
 */
export function termOverlap(question: string, text: string): number {
  const terms = queryTerms(question);
  if (!terms.length) return 0;
  const hay = tokenize(text);
  const set = new Set(hay);
  let hits = 0;
  for (const t of terms) {
    if (set.has(t)) hits += 1;
    else if (t.length >= 5 && hay.some((h) => h.startsWith(t.slice(0, 5)))) hits += 0.5;
  }
  return Number(Math.min(1, hits / terms.length).toFixed(2));
}

/** Deterministic answer when there is nothing to reason about (no model call). */
export function noSourcesAnswer(indexedEmails: number, language: "fr" | "en"): ChatAnswerLlm {
  const fr = language === "fr";
  const answer =
    indexedEmails === 0
      ? fr
        ? "Aucun email n'est encore indexé pour votre boîte : je ne peux rien retrouver. Ouvrez des emails dans le volet (ils sont indexés automatiquement à l'analyse) ou sélectionnez-en plusieurs, puis reposez votre question."
        : "No email is indexed for your mailbox yet, so there is nothing to search. Open emails in the pane (they are indexed automatically when analysed) or select several, then ask again."
      : fr
        ? `Aucun des ${indexedEmails} emails indexés ne correspond à votre question. Essayez d'autres mots-clés (un nom, un objet, un projet) ou ouvrez les emails concernés pour qu'ils soient indexés.`
        : `None of the ${indexedEmails} indexed emails matches your question. Try other keywords (a name, a subject, a project) or open the relevant emails so they get indexed.`;
  return { headline: fr ? (indexedEmails === 0 ? "Aucun email indexé" : "Aucune correspondance") : indexedEmails === 0 ? "No email indexed" : "No match", answer, sourceIds: [], confidence: 0.2 };
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

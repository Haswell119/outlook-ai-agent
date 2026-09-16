import type { DailyBrief, DetectedRisk, EmailAnalysis, Language, OpenTask, Priority } from "@oao/shared";
import { DailyBriefSchema } from "@oao/shared";
import { buildDailyBriefPrompt, DailyBriefLlmSchema } from "../domain/prompts/index.js";
import type { Metrics } from "../metrics.js";
import type { IndexedChunk } from "../ports/repositories.js";
import { nowIso } from "../util/ids.js";
import { truncate } from "../util/text.js";
import type { AiCacheService } from "./AiCacheService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import { completeStructured } from "./llm-helpers.js";

/**
 * Daily brief — "what matters this morning", assembled from work already done.
 *
 * Cost model: **zero** new analysis calls. Every fact comes from the
 * precomputed analyses written by the sync worker plus the email index. The
 * only model call is one short completion (~400 prompt tokens) that turns a
 * compact fact sheet into a headline and 3–6 bullets — and even that is skipped
 * when the model is unavailable or the circuit is open, in which case a
 * heuristic headline is used and `source` becomes `heuristic`.
 *
 * For 50 users that is 50 small calls a day, run at `DAILY_BRIEF_HOUR` at
 * background priority, i.e. a couple of GPU-minutes before anyone logs in.
 */
export interface BriefWindow {
  from: string;
  to: string;
  date: string;
}

export class DailyBriefService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly cache: AiCacheService,
    private readonly metrics?: Metrics,
  ) {}

  /** Today in the configured timezone (YYYY-MM-DD). */
  today(now: Date = new Date()): string {
    return localDateString(now, this.deps.cfg.TZ);
  }

  /**
   * Window covered by the brief of `date`: "since the previous brief", i.e.
   * from the previous day's brief hour up to this day's brief hour.
   *
   * One adjustment for the on-demand case: when the brief is (re)generated
   * *during* the day it is about, the window is extended to `now`, so a user
   * asking for their brief at 14:00 also sees the mail that arrived this
   * morning. A brief for a past date always keeps its historical window.
   */
  windowFor(date: string, now: Date = new Date()): BriefWindow {
    const anchor = utcInstantForLocal(date, this.deps.cfg.DAILY_BRIEF_HOUR, this.deps.cfg.TZ);
    const withinTheDay = now.getTime() > anchor.getTime() && now.getTime() < anchor.getTime() + 86_400_000;
    const to = withinTheDay ? now : anchor;
    return { date, from: new Date(anchor.getTime() - 86_400_000).toISOString(), to: to.toISOString() };
  }

  /** Stored brief, or 404-worthy `undefined`. */
  async getStored(userId: string, date: string): Promise<DailyBrief | undefined> {
    return this.deps.repos.dailyBriefs.get(userId, date);
  }

  /**
   * Build (and store) the brief for one user.
   * `priority: "background"` is used by the scheduled job so a user waiting in
   * Outlook always overtakes the morning batch.
   */
  async generate(ctx: RequestContext, opts: { date?: string; refresh?: boolean; priority?: "interactive" | "background" } = {}): Promise<DailyBrief> {
    const { user, language, correlationId } = ctx;
    const date = opts.date ?? this.today();
    if (!opts.refresh) {
      const stored = await this.getStored(user.id, date);
      if (stored) return stored;
    }

    const window = this.windowFor(date);
    const facts = await this.collectFacts(user.id, window, language);

    /* --------- headline + highlights: the single (optional) call --------- */
    let headline = heuristicHeadline(facts, language);
    let highlights = heuristicHighlights(facts, language);
    let confidence = 0.5;
    let source: DailyBrief["source"] = facts.analysed > 0 ? "precomputed" : "heuristic";
    let model: string | undefined;
    let latencyMs = 0;
    let promptTokens = 0;

    if (facts.newEmails > 0) {
      const prompt = buildDailyBriefPrompt({
        date,
        language,
        facts: {
          newEmails: facts.newEmails,
          analysed: facts.analysed,
          awaitingReply: facts.awaitingReply,
          phishingSuspected: facts.phishingSuspected,
          priority: facts.priorityEmails.map((p) => ({ subject: p.subject, from: p.from, reason: p.reason, priority: p.priority })),
          tasks: facts.openTasks.map((t) => t.title),
          deadlines: facts.deadlines.map((d) => ({ title: d.title, date: d.date, atRisk: d.atRisk })),
          alerts: facts.alerts.map((a) => ({ title: a.title, severity: a.severity })),
        },
      });
      promptTokens = prompt.tokens;
      const r = await completeStructured(
        this.deps.llm,
        DailyBriefLlmSchema,
        { ...prompt.request, userId: user.id, priority: opts.priority ?? "background" },
        () => ({ headline, highlights, confidence: 0.4 }),
        this.deps.logger,
      );
      latencyMs = r.latencyMs;
      if (!r.degraded) {
        headline = r.data.headline;
        highlights = r.data.highlights.length ? r.data.highlights : highlights;
        confidence = r.data.confidence;
        source = "llm";
        model = r.model;
      }
    }

    const brief = DailyBriefSchema.parse({
      date,
      language,
      headline: truncate(headline, 240),
      highlights: highlights.slice(0, 6),
      priorityEmails: facts.priorityEmails,
      openTasks: facts.openTasks,
      deadlines: facts.deadlines,
      alerts: facts.alerts,
      stats: { newEmails: facts.newEmails, analysed: facts.analysed, awaitingReply: facts.awaitingReply, phishingSuspected: facts.phishingSuspected },
      confidence,
      source,
      generatedAt: nowIso(),
      // Placeholder replaced right after the audit event is written.
      auditId: "pending",
    });

    const event = await this.audit.record({
      user,
      type: "summary_generated",
      source: { label: `Daily brief ${date}` },
      approvalStatus: "auto_approved",
      confidence,
      model: model ?? "heuristic-brief",
      latencyMs,
      correlationId,
      details: {
        kind: "daily_brief",
        date,
        window,
        source,
        cached: false,
        modelCallSkipped: source !== "llm",
        promptStats: { tokens: promptTokens },
        stats: brief.stats,
      },
    });

    const stored: DailyBrief = { ...brief, auditId: event.id };
    await this.deps.repos.dailyBriefs.put(user.id, stored);
    this.metrics?.briefs.inc({ source });
    return stored;
  }

  /* ------------------------------ facts -------------------------------- */

  /** Everything the brief says, derived from the index + precomputed analyses. */
  private async collectFacts(userId: string, window: BriefWindow, language: Language): Promise<BriefFacts> {
    const chunks = await this.deps.repos.emailIndex.listReceivedBetween(userId, window.from, window.to, 300);
    const analyses = new Map<string, EmailAnalysis>();
    for (const c of chunks) {
      const entry = await this.cache.byEmail<EmailAnalysis>(userId, c.emailId);
      const value = entry?.value as EmailAnalysis | undefined;
      if (value && typeof value === "object" && "summary" in value) analyses.set(c.emailId, value);
    }

    const priorityEmails: DailyBrief["priorityEmails"] = [];
    const taskTitles = new Set<string>();
    const openTasks: OpenTask[] = [];
    const deadlines: DailyBrief["deadlines"] = [];
    const alerts: DetectedRisk[] = [];
    let awaitingReply = 0;
    let phishingSuspected = 0;

    for (const c of chunks) {
      const a = analyses.get(c.emailId);
      if (!a) continue;
      if (a.phishing && a.phishing.verdict !== "clean") phishingSuspected++;
      const highRisk = a.risks.find((r) => r.severity === "high");
      const mediumRisk = a.risks.find((r) => r.severity === "medium");
      const needsReply = a.suggestedActions.some((s) => s.type === "draft_reply") || a.pendingTasks.length > 0;
      if (needsReply) awaitingReply++;

      if (highRisk || mediumRisk || needsReply) {
        const priority: Priority = highRisk ? "high" : needsReply || mediumRisk ? "medium" : "low";
        priorityEmails.push({
          emailId: c.emailId,
          conversationId: c.conversationId,
          subject: c.subject || "(no subject)",
          from: c.fromName ?? c.fromAddress,
          receivedAt: c.receivedAt,
          reason: truncate(highRisk?.title ?? mediumRisk?.title ?? a.pendingTasks[0] ?? a.summary, 160),
          priority,
          riskLevel: highRisk ? "high" : mediumRisk ? "medium" : "low",
          webLink: c.webLink,
        });
      }

      for (const t of a.pendingTasks) {
        const key = t.toLowerCase().trim();
        if (taskTitles.has(key) || openTasks.length >= 12) continue;
        taskTitles.add(key);
        openTasks.push({ title: truncate(t, 200), priority: highRisk ? "high" : "medium", done: false, critical: Boolean(highRisk) && openTasks.length === 0 });
      }

      for (const r of a.risks) {
        if (r.code === "deadline" && deadlines.length < 8) deadlines.push({ title: truncate(`${c.subject || r.title}`, 160), date: extractDate(r.description), description: r.description, atRisk: r.severity === "high" });
        if ((r.severity === "high" || r.code === "phishing_suspected" || r.code.startsWith("compliance")) && alerts.length < 8) alerts.push(r);
      }
    }

    priorityEmails.sort((a, b) => rank(b.priority) - rank(a.priority) || (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));

    return {
      language,
      newEmails: chunks.length,
      analysed: analyses.size,
      awaitingReply,
      phishingSuspected,
      priorityEmails: priorityEmails.slice(0, 8),
      openTasks,
      deadlines,
      alerts,
      chunks,
    };
  }
}

interface BriefFacts {
  language: Language;
  newEmails: number;
  analysed: number;
  awaitingReply: number;
  phishingSuspected: number;
  priorityEmails: DailyBrief["priorityEmails"];
  openTasks: OpenTask[];
  deadlines: DailyBrief["deadlines"];
  alerts: DetectedRisk[];
  chunks: IndexedChunk[];
}

const rank = (p: Priority): number => (p === "high" ? 3 : p === "medium" ? 2 : 1);

const extractDate = (s?: string): string | undefined => /\b(\d{4}-\d{2}-\d{2})\b/.exec(s ?? "")?.[1];

/** Headline used when the model is unavailable (or there is nothing to say). */
export function heuristicHeadline(f: Pick<BriefFacts, "newEmails" | "priorityEmails" | "phishingSuspected" | "awaitingReply">, language: Language): string {
  const fr = language === "fr";
  if (f.newEmails === 0) return fr ? "Aucun nouvel email depuis le dernier brief." : "No new email since the previous brief.";
  const top = f.priorityEmails[0];
  if (f.phishingSuspected > 0) return fr ? `${f.phishingSuspected} email(s) suspect(s) à vérifier, ${f.awaitingReply} en attente de réponse.` : `${f.phishingSuspected} suspicious email(s) to verify, ${f.awaitingReply} awaiting a reply.`;
  if (top) return fr ? `Priorité : « ${truncate(top.subject, 80)} » — ${truncate(top.reason, 90)}` : `Top priority: "${truncate(top.subject, 80)}" — ${truncate(top.reason, 90)}`;
  return fr ? `${f.newEmails} nouveaux emails, rien d'urgent détecté.` : `${f.newEmails} new emails, nothing urgent detected.`;
}

/** Bullets used when the model is unavailable. */
export function heuristicHighlights(f: BriefFacts, language: Language): string[] {
  const fr = language === "fr";
  const out: string[] = [];
  out.push(fr ? `${f.newEmails} nouveaux emails, ${f.analysed} analysés, ${f.awaitingReply} en attente de réponse.` : `${f.newEmails} new emails, ${f.analysed} analysed, ${f.awaitingReply} awaiting a reply.`);
  for (const p of f.priorityEmails.slice(0, 3)) out.push(`${p.priority === "high" ? "⚠ " : ""}${truncate(p.subject, 70)} — ${truncate(p.reason, 100)}`);
  const atRisk = f.deadlines.filter((d) => d.atRisk);
  if (atRisk.length) out.push(fr ? `${atRisk.length} échéance(s) à risque.` : `${atRisk.length} deadline(s) at risk.`);
  if (f.phishingSuspected) out.push(fr ? `${f.phishingSuspected} email(s) avec indicateurs de phishing.` : `${f.phishingSuspected} email(s) with phishing indicators.`);
  if (out.length < 3 && f.openTasks.length) out.push(fr ? `${f.openTasks.length} tâche(s) ouverte(s).` : `${f.openTasks.length} open task(s).`);
  return out.slice(0, 6);
}

/* ------------------------------ timezone ------------------------------- */

/** Offset of `tz` at `instant`, in ms (positive east of UTC). */
export function tzOffsetMs(instant: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value])) as Record<string, string>;
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return asUtc - instant.getTime();
  } catch {
    return 0; // unknown timezone → behave as UTC rather than crash the worker
  }
}

/** `YYYY-MM-DD` of `instant` in `tz`. */
export function localDateString(instant: Date, tz: string): string {
  return new Date(instant.getTime() + tzOffsetMs(instant, tz)).toISOString().slice(0, 10);
}

/** UTC instant of `date` at `hour:00` local time in `tz` (DST-correct). */
export function utcInstantForLocal(date: string, hour: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour);
  let guess = wall;
  // Two iterations converge even across a DST boundary.
  for (let i = 0; i < 2; i++) guess = wall - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

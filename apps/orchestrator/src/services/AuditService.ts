import type { AuditEvent, AuditEventType, AuditQuery, AuditStats, RiskLevel, ApprovalStatus } from "@oao/shared";
import { AuditEventSchema, AuditStatsSchema } from "@oao/shared";
import type { AuthenticatedUser } from "../auth/identity.js";
import { hasRole } from "../auth/identity.js";
import { AppError } from "../errors.js";
import type { AuditCursor, AuditRepository, AuditUserSummary } from "../ports/repositories.js";
import type { Metrics } from "../metrics.js";
import { sha256 } from "../util/hash.js";
import { newId, nowIso } from "../util/ids.js";
import type { Logger } from "./context.js";

export interface RecordInput {
  user: Pick<AuthenticatedUser, "id" | "email" | "displayName">;
  type: AuditEventType;
  source?: AuditEvent["source"];
  riskLevel?: RiskLevel;
  approvalStatus?: ApprovalStatus;
  approvedBy?: string;
  confidence?: number;
  model?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
  correlationId?: string;
}

/** Central audit writer + reader. Every AI suggestion / action goes through `record`. */
export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly storeContent: boolean,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {}

  /** SHA-256 hashes of prompt / response, and the raw content only when AUDIT_STORE_CONTENT=true. */
  hashes(prompt: string, response: string): Record<string, unknown> {
    const out: Record<string, unknown> = { promptHash: sha256(prompt), responseHash: sha256(response), promptChars: prompt.length, responseChars: response.length };
    if (this.storeContent) {
      out.prompt = prompt;
      out.response = response;
    }
    return out;
  }

  async record(input: RecordInput): Promise<AuditEvent> {
    const event = AuditEventSchema.parse({
      id: newId(),
      timestamp: nowIso(),
      user: { id: input.user.id, email: input.user.email, displayName: input.user.displayName },
      type: input.type,
      source: input.source,
      riskLevel: input.riskLevel,
      approvalStatus: input.approvalStatus ?? "n/a",
      approvedBy: input.approvedBy,
      confidence: input.confidence,
      model: input.model,
      latencyMs: input.latencyMs,
      details: input.details ?? {},
      correlationId: input.correlationId,
    });
    try {
      await this.repo.append(event);
    } catch (e) {
      // The audit trail is non-negotiable: surface loudly but never lose the user's response silently.
      this.logger.error({ err: (e as Error).message, event: event.type }, "failed to persist audit event");
      throw e;
    }
    this.metrics?.auditEvents.inc({ type: event.type });
    return event;
  }

  /** Users see their own events; admin / compliance see everything. */
  async query(user: AuthenticatedUser, q: AuditQuery) {
    const scoped = hasRole(user, "admin") || hasRole(user, "compliance") ? q : { ...q, userId: user.id };
    const { items, total } = await this.repo.query(scoped);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  async get(user: AuthenticatedUser, id: string): Promise<AuditEvent> {
    const event = await this.repo.get(id);
    if (!event || (!hasRole(user, "admin") && !hasRole(user, "compliance") && event.user.id !== user.id)) throw AppError.notFound("Audit event");
    return event;
  }

  async exportCsv(user: AuthenticatedUser, q: Omit<AuditQuery, "page" | "pageSize">, limit = 10_000): Promise<string> {
    let out = "";
    for await (const chunk of this.streamCsv(user, q, { limit })) out += chunk;
    return out;
  }

  /**
   * Streaming CSV export.
   *
   * Two years of audit for 50 users is millions of rows; buffering them would
   * OOM the pod and time out the request. This yields one page at a time using
   * **keyset pagination** (`(ts, id) < cursor`), which stays O(page) in the
   * database and stays correct while new events are being appended.
   */
  async *streamCsv(user: AuthenticatedUser, q: Omit<AuditQuery, "page" | "pageSize">, opts: { limit?: number; pageSize?: number } = {}): AsyncGenerator<string> {
    const scoped = hasRole(user, "admin") || hasRole(user, "compliance") ? q : { ...q, userId: user.id };
    const pageSize = Math.min(Math.max(opts.pageSize ?? 500, 1), 5_000);
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    yield CSV_HEADER.join(",");

    let cursor: AuditCursor | undefined;
    let emitted = 0;
    for (;;) {
      const want = Math.min(pageSize, limit - emitted);
      if (want <= 0) return;
      const rows = await this.repo.listPage(scoped, want, cursor);
      if (!rows.length) return;
      // Newline first, so the stream never ends with a blank line.
      yield `\n${rows.map(csvLine).join("\n")}`;
      emitted += rows.length;
      const last = rows[rows.length - 1]!;
      cursor = { timestamp: last.timestamp, id: last.id };
      if (rows.length < want) return;
    }
  }

  async users(): Promise<AuditUserSummary[]> {
    return this.repo.users();
  }

  /** Event counts by type (Prometheus gauge / admin system view). */
  async countsByType(): Promise<Record<string, number>> {
    return this.repo.countsByType();
  }

  async stats(from: string, to: string): Promise<AuditStats> {
    const agg = await this.repo.aggregates(from, to);
    const c = (t: string) => agg.countsByType[t] ?? 0;
    const p = (t: string) => agg.previousCountsByType[t] ?? 0;
    const delta = (cur: number, prev: number) => (prev === 0 ? (cur === 0 ? 0 : 100) : Number((((cur - prev) / prev) * 100).toFixed(1)));
    const kpis = {
      emailsSummarized: c("summary_generated") + c("thread_synthesis_generated"),
      draftsGenerated: c("draft_reply_generated"),
      automationsProposed: c("automation_proposed"),
      automationsApproved: c("automation_approved"),
      complianceAlerts: c("compliance_alert"),
      errorsAvoided: c("compliance_alert") + c("action_rejected") + c("compliance_escalated") + Object.entries(agg.countsByType).filter(([t]) => t === "phishing_check").reduce((a, [, n]) => a + n, 0),
    };
    const prev = {
      emailsSummarized: p("summary_generated") + p("thread_synthesis_generated"),
      draftsGenerated: p("draft_reply_generated"),
      automationsProposed: p("automation_proposed"),
      automationsApproved: p("automation_approved"),
      complianceAlerts: p("compliance_alert"),
      errorsAvoided: p("compliance_alert") + p("action_rejected") + p("compliance_escalated") + p("phishing_check"),
    };
    const deltas = Object.fromEntries((Object.keys(kpis) as Array<keyof typeof kpis>).map((k) => [k, delta(kpis[k], prev[k])]));

    // Activity over time: one row per day of the period.
    const days: string[] = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
    const dailyMap = new Map<string, Record<string, number>>();
    for (const d of agg.daily) {
      const row = dailyMap.get(d.date) ?? {};
      row[d.type] = (row[d.type] ?? 0) + d.count;
      dailyMap.set(d.date, row);
    }
    const activityOverTime = Array.from(new Set([...days, ...dailyMap.keys()]))
      .sort()
      .map((date) => {
        const r = dailyMap.get(date) ?? {};
        return {
          date,
          summaries: (r.summary_generated ?? 0) + (r.thread_synthesis_generated ?? 0),
          drafts: r.draft_reply_generated ?? 0,
          automations: (r.automation_proposed ?? 0) + (r.automation_approved ?? 0) + (r.automation_executed ?? 0),
          complianceAlerts: r.compliance_alert ?? 0,
        };
      });

    // Actions by type (grouped like the dashboard donut).
    const buckets: Record<string, number> = { Summarization: c("summary_generated") + c("thread_synthesis_generated"), "Draft generation": c("draft_reply_generated"), Automation: c("automation_proposed") + c("automation_approved") + c("automation_simulated") + c("automation_executed"), Classification: c("label_applied") + c("actions_proposed"), Compliance: c("compliance_check") + c("compliance_alert") + c("phishing_check") + c("compliance_escalated") + c("compliance_decision"), Search: c("search_executed") + c("chat_answered") };
    const other = agg.total - Object.values(buckets).reduce((a, b) => a + b, 0);
    if (other > 0) buckets.Other = other;
    const totalActions = agg.total;
    const actionsByType = Object.entries(buckets)
      .filter(([, n]) => n > 0)
      .map(([type, count]) => ({ type, count, share: totalActions ? Number(((count / totalActions) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.count - a.count);

    const catTotal = agg.complianceByCategory.reduce((a, b) => a + b.count, 0);
    const complianceAlertsByCategory = agg.complianceByCategory.map((x) => ({ category: x.category, count: x.count, share: catTotal ? Number(((x.count / catTotal) * 100).toFixed(1)) : 0 }));

    const rate = (approved: number, proposed: number) => (proposed ? Number(((approved / proposed) * 100).toFixed(1)) : 0);
    return AuditStatsSchema.parse({
      period: { from, to },
      kpis: { ...kpis, deltas },
      activityOverTime,
      actionsByType,
      complianceAlertsByCategory,
      automationsApprovalRate: { current: rate(kpis.automationsApproved, kpis.automationsProposed), previous: rate(prev.automationsApproved, prev.automationsProposed) },
      topUsers: agg.topUsers,
      totalActions,
    });
  }
}

const CSV_HEADER = ["id", "timestamp", "userId", "userEmail", "displayName", "type", "sourceLabel", "sourceEmailId", "sourceCounterpart", "riskLevel", "approvalStatus", "approvedBy", "confidence", "model", "latencyMs", "correlationId", "analysisSource", "cached"] as const;

/**
 * CSV cell for the audit export.
 *
 * Two escapes, both required:
 *  - RFC-4180 quoting, so a subject containing a comma or a newline does not
 *    shift every following column;
 *  - a leading `\'` in front of `= + - @ TAB CR`, because these cells carry
 *    attacker-influenced text (an email subject becomes `source.label`, a
 *    sender address becomes `source.counterpart`, a display name comes from the
 *    directory). Excel and LibreOffice treat such a cell as a formula, so an
 *    inbound email with the subject `=cmd|'/c calc'!A1` executes when a
 *    compliance officer opens the export. The dashboard's own fallback exporter
 *    already did this; the streamed path — the one actually used in production —
 *    did not.
 */
const csvEscape = (v: unknown): string => {
  const raw = v === undefined || v === null ? "" : String(v);
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvLine = (e: AuditEvent): string =>
  [e.id, e.timestamp, e.user.id, e.user.email, e.user.displayName, e.type, e.source?.label, e.source?.emailId, e.source?.counterpart, e.riskLevel, e.approvalStatus, e.approvedBy, e.confidence, e.model, e.latencyMs, e.correlationId, e.details?.analysisSource ?? e.details?.source, e.details?.cached]
    .map(csvEscape)
    .join(",");

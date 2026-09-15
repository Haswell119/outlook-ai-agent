import type { AuditEvent, AuditQuery } from "@oao/shared";
import { AuditEventSchema } from "@oao/shared";
import type { AuditAggregates, AuditRepository, AuditUserSummary } from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

interface Row {
  id: string;
  ts: Date;
  user_id: string;
  user_email: string;
  user_display_name: string | null;
  type: string;
  source_label: string | null;
  source_email_id: string | null;
  source_conversation_id: string | null;
  source_counterpart: string | null;
  risk_level: string | null;
  approval_status: string;
  approved_by: string | null;
  confidence: number | null;
  model: string | null;
  latency_ms: number | null;
  details: Record<string, unknown>;
  correlation_id: string | null;
}

const toEvent = (r: Row): AuditEvent =>
  AuditEventSchema.parse({
    id: r.id,
    timestamp: r.ts.toISOString(),
    user: { id: r.user_id, email: r.user_email, displayName: r.user_display_name ?? undefined },
    type: r.type,
    source: r.source_label ? { label: r.source_label, emailId: r.source_email_id ?? undefined, conversationId: r.source_conversation_id ?? undefined, counterpart: r.source_counterpart ?? undefined } : undefined,
    riskLevel: r.risk_level ?? undefined,
    approvalStatus: r.approval_status,
    approvedBy: r.approved_by ?? undefined,
    confidence: r.confidence ?? undefined,
    model: r.model ?? undefined,
    latencyMs: r.latency_ms ?? undefined,
    details: r.details ?? {},
    correlationId: r.correlation_id ?? undefined,
  });

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly pool: PgPool) {}

  async append(e: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id, ts, user_id, user_email, user_display_name, type, source_label, source_email_id, source_conversation_id,
                                 source_counterpart, risk_level, approval_status, approved_by, confidence, model, latency_ms, details, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        e.id, e.timestamp, e.user.id, e.user.email, e.user.displayName ?? null, e.type,
        e.source?.label ?? null, e.source?.emailId ?? null, e.source?.conversationId ?? null, e.source?.counterpart ?? null,
        e.riskLevel ?? null, e.approvalStatus, e.approvedBy ?? null, e.confidence ?? null, e.model ?? null, e.latencyMs ?? null,
        JSON.stringify(e.details ?? {}), e.correlationId ?? null,
      ],
    );
  }

  async get(id: string): Promise<AuditEvent | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM audit_events WHERE id = $1`, [id]);
    return rows[0] ? toEvent(rows[0]) : undefined;
  }

  private where(q: Omit<AuditQuery, "page" | "pageSize">): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      clauses.push(clause.replace("?", `$${params.length}`));
    };
    if (q.from) add("ts >= ?", q.from);
    if (q.to) add("ts <= ?", q.to);
    if (q.userId) add("(user_id = ? OR user_email = $" + (params.length + 1) + ")", q.userId);
    if (q.type) add("type = ?", q.type);
    if (q.riskLevel) add("risk_level = ?", q.riskLevel);
    if (q.approvalStatus) add("approval_status = ?", q.approvalStatus);
    if (q.search) add("(source_label ILIKE ? OR user_email ILIKE $" + (params.length + 1) + " OR user_display_name ILIKE $" + (params.length + 1) + " OR type ILIKE $" + (params.length + 1) + " OR source_counterpart ILIKE $" + (params.length + 1) + ")", `%${q.search}%`);
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async query(q: AuditQuery): Promise<{ items: AuditEvent[]; total: number }> {
    const { sql, params } = this.where(q);
    const total = Number((await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events ${sql}`, params)).rows[0]?.n ?? 0);
    const { rows } = await this.pool.query<Row>(`SELECT * FROM audit_events ${sql} ORDER BY ts DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items: rows.map(toEvent), total };
  }

  async list(q: Omit<AuditQuery, "page" | "pageSize">, limit: number): Promise<AuditEvent[]> {
    const { sql, params } = this.where(q);
    const { rows } = await this.pool.query<Row>(`SELECT * FROM audit_events ${sql} ORDER BY ts DESC LIMIT $${params.length + 1}`, [...params, limit]);
    return rows.map(toEvent);
  }

  async aggregates(from: string, to: string): Promise<AuditAggregates> {
    const span = Date.parse(to) - Date.parse(from);
    const prevFrom = new Date(Date.parse(from) - span).toISOString();
    const countByType = async (f: string, t: string, inclusive: boolean) => {
      const { rows } = await this.pool.query<{ type: string; n: string }>(`SELECT type, count(*)::text AS n FROM audit_events WHERE ts >= $1 AND ts ${inclusive ? "<=" : "<"} $2 GROUP BY type`, [f, t]);
      return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
    };
    const [countsByType, previousCountsByType, daily, cats, users, total] = await Promise.all([
      countByType(from, to, true),
      countByType(prevFrom, from, false),
      this.pool.query<{ date: string; type: string; n: string }>(
        `SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, type, count(*)::text AS n
           FROM audit_events WHERE ts >= $1 AND ts <= $2 GROUP BY 1, 2 ORDER BY 1`,
        [from, to],
      ),
      this.pool.query<{ category: string; n: string }>(
        `SELECT i->>'code' AS category, count(*)::text AS n
           FROM audit_events e, jsonb_array_elements(coalesce(e.details->'issues', '[]'::jsonb)) i
          WHERE e.type IN ('compliance_alert', 'compliance_check') AND e.ts >= $1 AND e.ts <= $2 AND i->>'code' IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
        [from, to],
      ),
      this.pool.query<{ user_id: string; display_name: string; n: string }>(
        `SELECT user_id, coalesce(max(user_display_name), max(user_email)) AS display_name, count(*)::text AS n
           FROM audit_events WHERE ts >= $1 AND ts <= $2 GROUP BY user_id ORDER BY count(*) DESC LIMIT 5`,
        [from, to],
      ),
      this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE ts >= $1 AND ts <= $2`, [from, to]),
    ]);
    return {
      countsByType,
      previousCountsByType,
      daily: daily.rows.map((r) => ({ date: r.date, type: r.type, count: Number(r.n) })),
      complianceByCategory: cats.rows.map((r) => ({ category: r.category, count: Number(r.n) })),
      topUsers: users.rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, actions: Number(r.n) })),
      total: Number(total.rows[0]?.n ?? 0),
    };
  }

  async users(): Promise<AuditUserSummary[]> {
    const { rows } = await this.pool.query<{ user_id: string; email: string; display_name: string | null; n: string; last: Date }>(
      `SELECT user_id, max(user_email) AS email, max(user_display_name) AS display_name, count(*)::text AS n, max(ts) AS last
         FROM audit_events GROUP BY user_id ORDER BY count(*) DESC`,
    );
    return rows.map((r) => ({ userId: r.user_id, email: r.email, displayName: r.display_name ?? undefined, events: Number(r.n), lastActivity: r.last.toISOString() }));
  }
}

import type { ComplianceIssue, Escalation } from "@oao/shared";
import type { EscalationRepository, StoredEscalation } from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

interface Row {
  id: string;
  user_id: string;
  status: Escalation["status"];
  requested_by: string;
  requested_at: Date;
  reason: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_comment: string | null;
  issues: ComplianceIssue[];
  action_id: string | null;
  draft: unknown;
}
const toEscalation = (r: Row): StoredEscalation => ({
  id: r.id,
  userId: r.user_id,
  status: r.status,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at.toISOString(),
  reason: r.reason,
  decidedBy: r.decided_by ?? undefined,
  decidedAt: r.decided_at?.toISOString(),
  decisionComment: r.decision_comment ?? undefined,
  issues: r.issues ?? [],
  actionId: r.action_id ?? undefined,
  draft: r.draft ?? undefined,
});

export class PgEscalationRepository implements EscalationRepository {
  constructor(private readonly pool: PgPool) {}

  async create(e: StoredEscalation): Promise<void> {
    await this.pool.query(
      `INSERT INTO escalations (id, user_id, status, requested_by, requested_at, reason, issues, action_id, draft) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.id, e.userId, e.status, e.requestedBy, e.requestedAt, e.reason, JSON.stringify(e.issues ?? []), e.actionId ?? null, e.draft ? JSON.stringify(e.draft) : null],
    );
  }
  async get(id: string): Promise<StoredEscalation | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM escalations WHERE id = $1`, [id]);
    return rows[0] ? toEscalation(rows[0]) : undefined;
  }
  async list(filter: { userId?: string; status?: Escalation["status"] }): Promise<StoredEscalation[]> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filter.userId) {
      params.push(filter.userId);
      clauses.push(`user_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    const { rows } = await this.pool.query<Row>(`SELECT * FROM escalations ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY requested_at DESC LIMIT 500`, params);
    return rows.map(toEscalation);
  }
  async update(e: StoredEscalation): Promise<void> {
    await this.pool.query(`UPDATE escalations SET status = $2, decided_by = $3, decided_at = $4, decision_comment = $5, issues = $6 WHERE id = $1`, [e.id, e.status, e.decidedBy ?? null, e.decidedAt ?? null, e.decisionComment ?? null, JSON.stringify(e.issues ?? [])]);
  }
}

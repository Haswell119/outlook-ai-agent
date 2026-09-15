import type { ProposedAction } from "@oao/shared";
import type { ActionRepository, StoredAction, StoredProposal } from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

interface ActionRow {
  id: string;
  proposal_id: string;
  action: ProposedAction;
  status: StoredAction["status"];
  message: string | null;
  updated_at: Date;
}
const toAction = (r: ActionRow): StoredAction => ({ action: r.action, proposalId: r.proposal_id, status: r.status, message: r.message ?? undefined, updatedAt: r.updated_at.toISOString() });

export class PgActionRepository implements ActionRepository {
  constructor(private readonly pool: PgPool) {}

  async saveProposal(p: StoredProposal): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO action_proposals (id, user_id, audit_id, email_id, conversation_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [p.id, p.userId, p.auditId, p.emailId ?? null, p.conversationId ?? null, p.createdAt, p.expiresAt]);
      for (const a of p.actions) {
        await client.query(`INSERT INTO proposed_actions (id, proposal_id, type, action, status, message, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [a.action.id, p.id, a.action.type, JSON.stringify(a.action), a.status, a.message ?? null, a.updatedAt]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async getProposal(id: string): Promise<StoredProposal | undefined> {
    const { rows } = await this.pool.query<{ id: string; user_id: string; audit_id: string; email_id: string | null; conversation_id: string | null; created_at: Date; expires_at: Date }>(`SELECT * FROM action_proposals WHERE id = $1`, [id]);
    const p = rows[0];
    if (!p) return undefined;
    const actions = await this.pool.query<ActionRow>(`SELECT * FROM proposed_actions WHERE proposal_id = $1 ORDER BY updated_at ASC, id ASC`, [id]);
    return { id: p.id, userId: p.user_id, auditId: p.audit_id, emailId: p.email_id ?? undefined, conversationId: p.conversation_id ?? undefined, createdAt: p.created_at.toISOString(), expiresAt: p.expires_at.toISOString(), actions: actions.rows.map(toAction) };
  }

  async getAction(actionId: string): Promise<StoredAction | undefined> {
    const { rows } = await this.pool.query<ActionRow>(`SELECT * FROM proposed_actions WHERE id = $1`, [actionId]);
    return rows[0] ? toAction(rows[0]) : undefined;
  }

  async updateAction(actionId: string, status: StoredAction["status"], message: string | undefined, updatedAt: string): Promise<void> {
    await this.pool.query(`UPDATE proposed_actions SET status = $2, message = $3, updated_at = $4 WHERE id = $1`, [actionId, status, message ?? null, updatedAt]);
  }
}

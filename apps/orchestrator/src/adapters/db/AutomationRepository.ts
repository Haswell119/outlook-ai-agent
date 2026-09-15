import type { Automation } from "@oao/shared";
import type { AutomationRepository, StoredAutomation, StoredUserActionEvent, UserActionEventRepository } from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

interface Row {
  id: string;
  user_id: string;
  fingerprint: string;
  name: string;
  description: string;
  trigger: Automation["trigger"];
  steps: Automation["steps"];
  status: Automation["status"];
  stats: Automation["stats"];
  confidence: number;
  risk_level: Automation["riskLevel"];
  last_simulation: Automation["lastSimulation"] | null;
  created_at: Date;
  updated_at: Date;
}
const toAutomation = (r: Row): StoredAutomation => ({
  id: r.id,
  userId: r.user_id,
  fingerprint: r.fingerprint,
  name: r.name,
  description: r.description,
  trigger: r.trigger,
  steps: r.steps,
  status: r.status,
  stats: r.stats,
  confidence: Number(r.confidence),
  riskLevel: r.risk_level,
  lastSimulation: r.last_simulation ?? undefined,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export class PgAutomationRepository implements AutomationRepository {
  constructor(private readonly pool: PgPool) {}

  async save(a: StoredAutomation): Promise<void> {
    await this.pool.query(
      `INSERT INTO automations (id, user_id, fingerprint, name, description, trigger, steps, status, stats, confidence, risk_level, last_simulation, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, trigger = EXCLUDED.trigger, steps = EXCLUDED.steps,
         status = EXCLUDED.status, stats = EXCLUDED.stats, confidence = EXCLUDED.confidence, risk_level = EXCLUDED.risk_level,
         last_simulation = EXCLUDED.last_simulation, updated_at = EXCLUDED.updated_at, fingerprint = EXCLUDED.fingerprint`,
      [a.id, a.userId, a.fingerprint, a.name, a.description, JSON.stringify(a.trigger), JSON.stringify(a.steps), a.status, JSON.stringify(a.stats), a.confidence, a.riskLevel, a.lastSimulation ? JSON.stringify(a.lastSimulation) : null, a.createdAt, a.updatedAt],
    );
  }
  async get(id: string): Promise<StoredAutomation | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM automations WHERE id = $1`, [id]);
    return rows[0] ? toAutomation(rows[0]) : undefined;
  }
  async list(userId?: string): Promise<StoredAutomation[]> {
    const { rows } = userId
      ? await this.pool.query<Row>(`SELECT * FROM automations WHERE user_id = $1 ORDER BY updated_at DESC`, [userId])
      : await this.pool.query<Row>(`SELECT * FROM automations ORDER BY updated_at DESC LIMIT 500`);
    return rows.map(toAutomation);
  }
  async findByFingerprint(userId: string, fingerprint: string): Promise<StoredAutomation | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT * FROM automations WHERE user_id = $1 AND fingerprint = $2`, [userId, fingerprint]);
    return rows[0] ? toAutomation(rows[0]) : undefined;
  }
}

export class PgUserActionEventRepository implements UserActionEventRepository {
  constructor(private readonly pool: PgPool) {}

  async append(events: StoredUserActionEvent[]): Promise<void> {
    if (!events.length) return;
    const values: unknown[] = [];
    const rows = events.map((e) => {
      values.push(e.id, e.userId, e.type, e.occurredAt, JSON.stringify(e.email), JSON.stringify(e.parameters ?? {}));
      const b = values.length - 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await this.pool.query(`INSERT INTO user_action_events (id, user_id, type, occurred_at, email, parameters) VALUES ${rows.join(", ")} ON CONFLICT (id) DO NOTHING`, values);
  }
  async listSince(userId: string, sinceIso: string): Promise<StoredUserActionEvent[]> {
    const { rows } = await this.pool.query<{ id: string; user_id: string; type: StoredUserActionEvent["type"]; occurred_at: Date; email: StoredUserActionEvent["email"]; parameters: Record<string, unknown> }>(
      `SELECT * FROM user_action_events WHERE user_id = $1 AND occurred_at >= $2 ORDER BY occurred_at ASC LIMIT 5000`,
      [userId, sinceIso],
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, type: r.type, occurredAt: r.occurred_at.toISOString(), email: r.email, parameters: r.parameters ?? {} }));
  }
}

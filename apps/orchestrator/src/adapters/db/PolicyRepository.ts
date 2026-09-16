import type { Policy } from "@oao/shared";
import { PolicySchema } from "@oao/shared";
import type { FeedbackRecord, FeedbackRepository, PolicyRepository } from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

export class PgPolicyRepository implements PolicyRepository {
  constructor(private readonly pool: PgPool) {}
  async get(): Promise<Policy | undefined> {
    const { rows } = await this.pool.query<{ policy: unknown; updated_at: Date; updated_by: string | null }>(`SELECT policy, updated_at, updated_by FROM policies WHERE id = 'default'`);
    const r = rows[0];
    if (!r) return undefined;
    const parsed = PolicySchema.safeParse(r.policy);
    return parsed.success ? { ...parsed.data, updatedAt: r.updated_at.toISOString(), updatedBy: r.updated_by ?? undefined } : undefined;
  }
  async put(policy: Policy): Promise<void> {
    await this.pool.query(
      `INSERT INTO policies (id, policy, updated_at, updated_by) VALUES ('default', $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET policy = EXCLUDED.policy, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(policy), policy.updatedAt ?? new Date().toISOString(), policy.updatedBy ?? null],
    );
  }
}

export class PgFeedbackRepository implements FeedbackRepository {
  constructor(private readonly pool: PgPool) {}
  async save(f: FeedbackRecord): Promise<void> {
    await this.pool.query(`INSERT INTO feedback (id, audit_id, user_id, rating, comment, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [f.id, f.auditId, f.userId, f.rating, f.comment ?? null, f.createdAt]);
  }
}

import type { DailyBrief } from "@oao/shared";
import type {
  AnalysisCacheEntry,
  AnalysisCacheRepository,
  DailyBriefRepository,
  EmbeddingCacheRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  MailboxSyncRepository,
  MailboxSyncState,
} from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

const iso = (v: Date | string | null | undefined): string | undefined => (v == null ? undefined : v instanceof Date ? v.toISOString() : String(v));

/* --------------------------- analysis_cache ----------------------------- */

interface AnalysisRow {
  user_id: string;
  cache_key: string;
  kind: AnalysisCacheEntry["kind"];
  email_id: string | null;
  conversation_id: string | null;
  value: unknown;
  model: string | null;
  origin: AnalysisCacheEntry["origin"];
  created_at: Date;
  expires_at: Date;
}

const toEntry = <T>(r: AnalysisRow): AnalysisCacheEntry<T> => ({
  key: r.cache_key,
  kind: r.kind,
  userId: r.user_id,
  emailId: r.email_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  value: r.value as T,
  model: r.model ?? undefined,
  origin: r.origin,
  createdAt: iso(r.created_at)!,
  expiresAt: iso(r.expires_at)!,
});

/** Content-hash cache of model answers. TTL is enforced on read *and* by the purge job. */
export class PgAnalysisCacheRepository implements AnalysisCacheRepository {
  constructor(private readonly pool: PgPool) {}

  async get<T>(userId: string, key: string): Promise<AnalysisCacheEntry<T> | undefined> {
    const r = await this.pool.query<AnalysisRow>(`SELECT * FROM analysis_cache WHERE user_id = $1 AND cache_key = $2 AND expires_at > now()`, [userId, key]);
    return r.rows[0] ? toEntry<T>(r.rows[0]) : undefined;
  }

  async put<T>(e: AnalysisCacheEntry<T>): Promise<void> {
    await this.pool.query(
      `INSERT INTO analysis_cache (user_id, cache_key, kind, email_id, conversation_id, value, model, origin, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT (user_id, cache_key) DO UPDATE
         SET value = EXCLUDED.value, model = EXCLUDED.model, origin = EXCLUDED.origin,
             email_id = EXCLUDED.email_id, conversation_id = EXCLUDED.conversation_id,
             created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [e.userId, e.key, e.kind, e.emailId ?? null, e.conversationId ?? null, JSON.stringify(e.value), e.model ?? null, e.origin, e.createdAt, e.expiresAt],
    );
  }

  async getByEmail<T>(userId: string, emailId: string): Promise<AnalysisCacheEntry<T> | undefined> {
    const r = await this.pool.query<AnalysisRow>(
      `SELECT * FROM analysis_cache
       WHERE user_id = $1 AND email_id = $2 AND kind = 'analysis' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [userId, emailId],
    );
    return r.rows[0] ? toEntry<T>(r.rows[0]) : undefined;
  }

  async countPrecomputed(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM analysis_cache WHERE user_id = $1 AND kind = 'analysis' AND origin = 'precomputed' AND expires_at > now()`, [userId]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async purgeExpired(nowIso: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM analysis_cache WHERE expires_at <= $1`, [nowIso]);
    return r.rowCount ?? 0;
  }
}

/* --------------------------- embedding_cache ---------------------------- */

/** Vectors keyed by (model, chunk hash) so re-indexing never re-embeds unchanged text. */
export class PgEmbeddingCacheRepository implements EmbeddingCacheRepository {
  constructor(private readonly pool: PgPool) {}

  async getMany(model: string, keys: string[]): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (!keys.length) return out;
    const r = await this.pool.query<{ cache_key: string; embedding: number[] }>(`SELECT cache_key, embedding FROM embedding_cache WHERE model = $1 AND cache_key = ANY($2::text[]) AND expires_at > now()`, [model, keys]);
    for (const row of r.rows) out.set(row.cache_key, row.embedding.map(Number));
    return out;
  }

  async putMany(model: string, entries: Array<{ key: string; embedding: number[] }>, expiresAt: string): Promise<void> {
    if (!entries.length) return;
    // One multi-row INSERT: 64 vectors per index batch would otherwise be 64 round-trips.
    const values: string[] = [];
    const params: unknown[] = [model, expiresAt];
    for (const e of entries) {
      params.push(e.key, e.embedding, e.embedding.length);
      const i = params.length;
      values.push(`($1, $${i - 2}, $${i - 1}::real[], $${i}, $2)`);
    }
    await this.pool.query(
      `INSERT INTO embedding_cache (model, cache_key, embedding, dims, expires_at) VALUES ${values.join(", ")}
       ON CONFLICT (model, cache_key) DO UPDATE SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims, expires_at = EXCLUDED.expires_at`,
      params,
    );
  }

  async purgeExpired(nowIso: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM embedding_cache WHERE expires_at <= $1`, [nowIso]);
    return r.rowCount ?? 0;
  }

  async count(): Promise<number> {
    const r = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM embedding_cache`);
    return Number(r.rows[0]?.n ?? 0);
  }
}

/* -------------------------- mailbox_sync_state -------------------------- */

interface SyncRow {
  user_id: string;
  user_email: string;
  delta_token: string | null;
  state: MailboxSyncState["state"];
  last_sync_at: Date | null;
  next_sync_at: Date | null;
  last_error: string | null;
  indexed_emails: number;
  precomputed_analyses: number;
  pending: number;
  auth_mode: MailboxSyncState["authMode"];
  msal_home_account_id: string | null;
  updated_at: Date;
}

const toState = (r: SyncRow): MailboxSyncState => ({
  userId: r.user_id,
  userEmail: r.user_email,
  deltaToken: r.delta_token ?? undefined,
  state: r.state,
  lastSyncAt: iso(r.last_sync_at),
  nextSyncAt: iso(r.next_sync_at),
  lastError: r.last_error ?? undefined,
  indexedEmails: Number(r.indexed_emails),
  precomputedAnalyses: Number(r.precomputed_analyses),
  pending: Number(r.pending),
  authMode: r.auth_mode,
  msalHomeAccountId: r.msal_home_account_id ?? undefined,
  updatedAt: iso(r.updated_at)!,
});

export class PgMailboxSyncRepository implements MailboxSyncRepository {
  constructor(private readonly pool: PgPool) {}

  async get(userId: string): Promise<MailboxSyncState | undefined> {
    const r = await this.pool.query<SyncRow>(`SELECT * FROM mailbox_sync_state WHERE user_id = $1`, [userId]);
    return r.rows[0] ? toState(r.rows[0]) : undefined;
  }

  async put(s: MailboxSyncState): Promise<void> {
    await this.pool.query(
      `INSERT INTO mailbox_sync_state (user_id, user_email, delta_token, state, last_sync_at, next_sync_at, last_error, indexed_emails, precomputed_analyses, pending, auth_mode, msal_home_account_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (user_id) DO UPDATE SET
         user_email = EXCLUDED.user_email, delta_token = EXCLUDED.delta_token, state = EXCLUDED.state,
         last_sync_at = EXCLUDED.last_sync_at, next_sync_at = EXCLUDED.next_sync_at, last_error = EXCLUDED.last_error,
         indexed_emails = EXCLUDED.indexed_emails, precomputed_analyses = EXCLUDED.precomputed_analyses,
         pending = EXCLUDED.pending, auth_mode = EXCLUDED.auth_mode,
         msal_home_account_id = EXCLUDED.msal_home_account_id, updated_at = EXCLUDED.updated_at`,
      [s.userId, s.userEmail, s.deltaToken ?? null, s.state, s.lastSyncAt ?? null, s.nextSyncAt ?? null, s.lastError ?? null, s.indexedEmails, s.precomputedAnalyses, s.pending, s.authMode, s.msalHomeAccountId ?? null, s.updatedAt],
    );
  }

  async list(): Promise<MailboxSyncState[]> {
    const r = await this.pool.query<SyncRow>(`SELECT * FROM mailbox_sync_state ORDER BY user_email`);
    return r.rows.map(toState);
  }

  async listDue(nowIso: string, limit: number): Promise<MailboxSyncState[]> {
    const r = await this.pool.query<SyncRow>(
      `SELECT * FROM mailbox_sync_state
       WHERE state <> 'disabled' AND (next_sync_at IS NULL OR next_sync_at <= $1)
       ORDER BY last_sync_at NULLS FIRST LIMIT $2`,
      [nowIso, limit],
    );
    return r.rows.map(toState);
  }
}

/* ----------------------------- daily_briefs ----------------------------- */

export class PgDailyBriefRepository implements DailyBriefRepository {
  constructor(private readonly pool: PgPool) {}

  async get(userId: string, date: string): Promise<DailyBrief | undefined> {
    const r = await this.pool.query<{ brief: DailyBrief }>(`SELECT brief FROM daily_briefs WHERE user_id = $1 AND brief_date = $2::date`, [userId, date]);
    return r.rows[0]?.brief;
  }

  async put(userId: string, brief: DailyBrief): Promise<void> {
    await this.pool.query(
      `INSERT INTO daily_briefs (user_id, brief_date, brief, source, generated_at)
       VALUES ($1,$2::date,$3::jsonb,$4,$5)
       ON CONFLICT (user_id, brief_date) DO UPDATE SET brief = EXCLUDED.brief, source = EXCLUDED.source, generated_at = EXCLUDED.generated_at`,
      [userId, brief.date, JSON.stringify(brief), brief.source, brief.generatedAt],
    );
  }

  async purgeOlderThan(beforeDate: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM daily_briefs WHERE brief_date < $1::date`, [beforeDate]);
    return r.rowCount ?? 0;
  }
}

/* -------------------------- idempotency_keys ---------------------------- */

export class PgIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly pool: PgPool) {}

  async get(userId: string, key: string): Promise<IdempotencyRecord | undefined> {
    const r = await this.pool.query<{ user_id: string; idem_key: string; request_hash: string; response: unknown; created_at: Date; expires_at: Date }>(
      `SELECT * FROM idempotency_keys WHERE user_id = $1 AND idem_key = $2 AND expires_at > now()`,
      [userId, key],
    );
    const row = r.rows[0];
    return row ? { key: row.idem_key, userId: row.user_id, requestHash: row.request_hash, response: row.response, createdAt: iso(row.created_at)!, expiresAt: iso(row.expires_at)! } : undefined;
  }

  async put(record: IdempotencyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, response, created_at, expires_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (user_id, idem_key) DO NOTHING`,
      [record.userId, record.key, record.requestHash, JSON.stringify(record.response), record.createdAt, record.expiresAt],
    );
  }

  async purgeExpired(nowIso: string): Promise<number> {
    const r = await this.pool.query(`DELETE FROM idempotency_keys WHERE expires_at <= $1`, [nowIso]);
    return r.rowCount ?? 0;
  }
}

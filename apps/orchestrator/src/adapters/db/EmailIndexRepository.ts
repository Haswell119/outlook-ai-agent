import type { EmailIndexRepository, IndexHit, IndexSearchFilter, IndexedChunk } from "../../ports/repositories.js";
import { toTsQuery } from "../../util/text.js";
import type { PgPool } from "./pool.js";

interface Row {
  user_id: string;
  email_id: string;
  conversation_id: string | null;
  internet_message_id: string | null;
  subject: string;
  from_name: string | null;
  from_address: string | null;
  received_at: Date | null;
  folder: string | null;
  web_link: string | null;
  has_attachments: boolean;
  attachment_names: string[];
  chunk_no: number;
  body_text: string;
  score?: number;
}

const toChunk = (r: Row): IndexedChunk => ({
  userId: r.user_id,
  emailId: r.email_id,
  conversationId: r.conversation_id ?? undefined,
  internetMessageId: r.internet_message_id ?? undefined,
  subject: r.subject,
  fromName: r.from_name ?? undefined,
  fromAddress: r.from_address ?? undefined,
  receivedAt: r.received_at?.toISOString(),
  folder: r.folder ?? undefined,
  webLink: r.web_link ?? undefined,
  hasAttachments: r.has_attachments,
  attachmentNames: r.attachment_names ?? [],
  chunkNo: r.chunk_no,
  bodyText: r.body_text,
});

const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

export class PgEmailIndexRepository implements EmailIndexRepository {
  private vectorSupport: boolean | undefined;
  constructor(private readonly pool: PgPool) {}

  async supportsVectors(): Promise<boolean> {
    if (this.vectorSupport === undefined) {
      const { rows } = await this.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'email_index' AND column_name = 'embedding'`);
      this.vectorSupport = rows.length > 0;
    }
    return this.vectorSupport;
  }

  async upsertEmail(userId: string, chunks: IndexedChunk[]): Promise<void> {
    const emailId = chunks[0]?.emailId;
    if (!emailId) return;
    const vectors = await this.supportsVectors();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM email_index WHERE user_id = $1 AND email_id = $2`, [userId, emailId]);
      for (const c of chunks) {
        const cols = ["user_id", "email_id", "conversation_id", "internet_message_id", "subject", "from_name", "from_address", "received_at", "folder", "web_link", "has_attachments", "attachment_names", "chunk_no", "body_text"];
        const vals: unknown[] = [userId, c.emailId, c.conversationId ?? null, c.internetMessageId ?? null, c.subject, c.fromName ?? null, c.fromAddress ?? null, c.receivedAt ?? null, c.folder ?? null, c.webLink ?? null, c.hasAttachments ?? false, c.attachmentNames ?? [], c.chunkNo, c.bodyText];
        if (vectors && c.embedding) {
          cols.push("embedding");
          vals.push(toVectorLiteral(c.embedding));
        }
        const placeholders = vals.map((_, i) => (cols[i] === "embedding" ? `$${i + 1}::vector` : `$${i + 1}`));
        await client.query(`INSERT INTO email_index (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`, vals);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private filterSql(filter: IndexSearchFilter, params: unknown[]): string {
    const clauses: string[] = [];
    if (filter.conversationId) {
      params.push(filter.conversationId);
      clauses.push(`conversation_id = $${params.length}`);
    }
    if (filter.folder) {
      params.push(filter.folder);
      clauses.push(`lower(folder) = lower($${params.length})`);
    }
    if (filter.from) {
      params.push(filter.from);
      clauses.push(`received_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      clauses.push(`received_at <= $${params.length}`);
    }
    return clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  }

  async searchLexical(userId: string, query: string, filter: IndexSearchFilter, limit: number): Promise<IndexHit[]> {
    const tsquery = toTsQuery(query);
    if (!tsquery) return [];
    const params: unknown[] = [userId, tsquery];
    const extra = this.filterSql(filter, params);
    params.push(limit);
    // Terms are OR-ed (see toTsQuery); ts_rank orders by how many of them each chunk matches (subject weighted A).
    const { rows } = await this.pool.query<Row>(
      `SELECT user_id, email_id, conversation_id, internet_message_id, subject, from_name, from_address, received_at, folder, web_link,
              has_attachments, attachment_names, chunk_no, body_text,
              ts_rank(tsv, to_tsquery('simple', $2)) AS score
         FROM email_index
        WHERE user_id = $1 AND tsv @@ to_tsquery('simple', $2)${extra}
        ORDER BY score DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({ chunk: toChunk(r), score: Number(r.score ?? 0) }));
  }

  async searchVector(userId: string, embedding: number[], filter: IndexSearchFilter, limit: number): Promise<IndexHit[]> {
    if (!(await this.supportsVectors())) return [];
    const params: unknown[] = [userId, toVectorLiteral(embedding)];
    const extra = this.filterSql(filter, params);
    params.push(limit);
    const { rows } = await this.pool.query<Row>(
      `SELECT user_id, email_id, conversation_id, internet_message_id, subject, from_name, from_address, received_at, folder, web_link,
              has_attachments, attachment_names, chunk_no, body_text,
              1 - (embedding <=> $2::vector) AS score
         FROM email_index
        WHERE user_id = $1 AND embedding IS NOT NULL${extra}
        ORDER BY embedding <=> $2::vector LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => ({ chunk: toChunk(r), score: Number(r.score ?? 0) }));
  }

  async listRecent(userId: string, filter: { fromAddress?: string; fromDomain?: string; subjectContains?: string; hasAttachments?: boolean }, limit: number): Promise<IndexedChunk[]> {
    const params: unknown[] = [userId];
    const clauses: string[] = [];
    if (filter.fromAddress) {
      params.push(filter.fromAddress.toLowerCase());
      clauses.push(`lower(from_address) = $${params.length}`);
    }
    if (filter.fromDomain) {
      params.push(filter.fromDomain.toLowerCase());
      clauses.push(`(lower(from_address) LIKE '%@' || $${params.length} OR lower(from_address) LIKE '%.' || $${params.length})`);
    }
    if (filter.subjectContains) {
      params.push(`%${filter.subjectContains}%`);
      clauses.push(`subject ILIKE $${params.length}`);
    }
    if (filter.hasAttachments !== undefined) {
      params.push(filter.hasAttachments);
      clauses.push(`has_attachments = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await this.pool.query<Row>(
      `SELECT user_id, email_id, conversation_id, internet_message_id, subject, from_name, from_address, received_at, folder, web_link,
              has_attachments, attachment_names, chunk_no, body_text
         FROM email_index WHERE user_id = $1 AND chunk_no = 0${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
        ORDER BY received_at DESC NULLS LAST LIMIT $${params.length}`,
      params,
    );
    return rows.map(toChunk);
  }

  async count(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT count(DISTINCT email_id)::text AS n FROM email_index WHERE user_id = $1`, [userId]);
    return Number(rows[0]?.n ?? 0);
  }
}

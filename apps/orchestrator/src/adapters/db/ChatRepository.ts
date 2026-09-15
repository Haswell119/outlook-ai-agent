import type { ChatMessage } from "@oao/shared";
import type { ChatRepository, ChatSession } from "../../ports/repositories.js";
import type { PgPool } from "./pool.js";

export class PgChatRepository implements ChatRepository {
  constructor(private readonly pool: PgPool) {}

  async createSession(s: ChatSession): Promise<void> {
    await this.pool.query(`INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`, [s.id, s.userId, s.title ?? null, s.createdAt, s.updatedAt]);
  }
  async getSession(id: string): Promise<ChatSession | undefined> {
    const { rows } = await this.pool.query<{ id: string; user_id: string; title: string | null; created_at: Date; updated_at: Date }>(`SELECT * FROM chat_sessions WHERE id = $1`, [id]);
    const r = rows[0];
    return r ? { id: r.id, userId: r.user_id, title: r.title ?? undefined, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() } : undefined;
  }
  async appendMessage(sessionId: string, m: ChatMessage & { auditId?: string }): Promise<void> {
    await this.pool.query(`INSERT INTO chat_messages (session_id, role, content, sources, audit_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [sessionId, m.role, m.content, m.sources ? JSON.stringify(m.sources) : null, m.auditId ?? null, m.createdAt]);
  }
  async listMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    const { rows } = await this.pool.query<{ role: "user" | "assistant"; content: string; sources: ChatMessage["sources"] | null; created_at: Date }>(
      `SELECT role, content, sources, created_at FROM (SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) t ORDER BY id ASC`,
      [sessionId, limit],
    );
    return rows.map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at.toISOString(), sources: r.sources ?? undefined }));
  }
  async touch(sessionId: string, updatedAt: string): Promise<void> {
    await this.pool.query(`UPDATE chat_sessions SET updated_at = $2 WHERE id = $1`, [sessionId, updatedAt]);
  }
}

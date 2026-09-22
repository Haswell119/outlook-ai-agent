import type { AuditEvent, AuditQuery, ChatMessage, Escalation, Policy } from "@oao/shared";
import { emailDomain } from "@oao/shared";
import type {
  ActionRepository,
  AuditCursor,
  AuditAggregates,
  AuditRepository,
  AuditUserSummary,
  AutomationRepository,
  ChatRepository,
  ChatSession,
  EmailIndexRepository,
  EscalationRepository,
  FeedbackRecord,
  FeedbackRepository,
  IndexHit,
  IndexSearchFilter,
  IndexedChunk,
  PolicyRepository,
  Repositories,
  StoredAction,
  StoredAutomation,
  StoredEscalation,
  StoredProposal,
  StoredUserActionEvent,
  UserActionEventRepository,
} from "../../ports/repositories.js";
import { queryTerms, tokenize } from "../../util/text.js";
import {
  MemoryAnalysisCacheRepository,
  MemoryDailyBriefRepository,
  MemoryEmbeddingCacheRepository,
  MemoryIdempotencyRepository,
  MemoryMailboxSyncRepository,
} from "./caches.js";

/**
 * In-memory implementation of every repository port. Used by unit tests and by
 * the `DATABASE_URL=memory` demo mode. Semantics mirror the SQL implementation.
 */

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(clone(event));
  }
  async get(id: string): Promise<AuditEvent | undefined> {
    const e = this.events.find((x) => x.id === id);
    return e ? clone(e) : undefined;
  }
  private filter(q: Omit<AuditQuery, "page" | "pageSize">): AuditEvent[] {
    const search = q.search?.toLowerCase();
    return this.events
      .filter((e) => (!q.from || e.timestamp >= q.from) && (!q.to || e.timestamp <= q.to))
      .filter((e) => !q.userId || e.user.id === q.userId || e.user.email === q.userId)
      .filter((e) => !q.type || e.type === q.type)
      .filter((e) => !q.riskLevel || e.riskLevel === q.riskLevel)
      .filter((e) => !q.approvalStatus || e.approvalStatus === q.approvalStatus)
      .filter((e) => !q.source || e.details.source === q.source)
      .filter((e) => !q.model || e.model === q.model)
      .filter((e) => !search || `${e.source?.label ?? ""} ${e.user.email} ${e.user.displayName ?? ""} ${e.type} ${e.source?.counterpart ?? ""}`.toLowerCase().includes(search))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }
  async query(q: AuditQuery): Promise<{ items: AuditEvent[]; total: number }> {
    const all = this.filter(q);
    const start = (q.page - 1) * q.pageSize;
    return { items: clone(all.slice(start, start + q.pageSize)), total: all.length };
  }
  async list(q: Omit<AuditQuery, "page" | "pageSize">, limit: number): Promise<AuditEvent[]> {
    return clone(this.filter(q).slice(0, limit));
  }
  async listPage(q: Omit<AuditQuery, "page" | "pageSize">, limit: number, cursor?: AuditCursor): Promise<AuditEvent[]> {
    const all = this.filter(q); // newest first
    const after = cursor
      ? all.filter((e) => e.timestamp < cursor.timestamp || (e.timestamp === cursor.timestamp && e.id < cursor.id))
      : all;
    return clone(after.slice(0, limit));
  }
  async purgeOlderThan(beforeIso: string): Promise<number> {
    let n = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if ((this.events[i]?.timestamp ?? "") < beforeIso) {
        this.events.splice(i, 1);
        n++;
      }
    }
    return n;
  }
  async countsByType(): Promise<Record<string, number>> {
    return this.events.reduce<Record<string, number>>((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {});
  }
  async aggregates(from: string, to: string): Promise<AuditAggregates> {
    const span = Date.parse(to) - Date.parse(from);
    const prevFrom = new Date(Date.parse(from) - span).toISOString();
    const inPeriod = this.events.filter((e) => e.timestamp >= from && e.timestamp <= to);
    const inPrev = this.events.filter((e) => e.timestamp >= prevFrom && e.timestamp < from);
    const count = (list: AuditEvent[]) => list.reduce<Record<string, number>>((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {});
    const dailyMap = new Map<string, number>();
    for (const e of inPeriod) {
      const key = `${e.timestamp.slice(0, 10)}|${e.type}`;
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
    }
    const daily = Array.from(dailyMap.entries()).map(([k, count]) => ({ date: k.split("|")[0]!, type: k.split("|")[1]!, count })).sort((a, b) => a.date.localeCompare(b.date));
    const cats = new Map<string, number>();
    for (const e of inPeriod.filter((x) => x.type === "compliance_alert" || x.type === "compliance_check")) {
      const issues = (e.details.issues as Array<{ code?: string }> | undefined) ?? [];
      for (const i of issues) if (i.code) cats.set(i.code, (cats.get(i.code) ?? 0) + 1);
    }
    const users = new Map<string, { displayName: string; actions: number }>();
    for (const e of inPeriod) {
      const u = users.get(e.user.id) ?? { displayName: e.user.displayName ?? e.user.email, actions: 0 };
      u.actions++;
      users.set(e.user.id, u);
    }
    return {
      countsByType: count(inPeriod),
      previousCountsByType: count(inPrev),
      daily,
      complianceByCategory: Array.from(cats.entries()).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      topUsers: Array.from(users.entries()).map(([userId, u]) => ({ userId, ...u })).sort((a, b) => b.actions - a.actions).slice(0, 5),
      total: inPeriod.length,
    };
  }
  async users(): Promise<AuditUserSummary[]> {
    const map = new Map<string, AuditUserSummary>();
    for (const e of this.events) {
      const u = map.get(e.user.id) ?? { userId: e.user.id, email: e.user.email, displayName: e.user.displayName, events: 0, lastActivity: e.timestamp };
      u.events++;
      if (e.timestamp > u.lastActivity) u.lastActivity = e.timestamp;
      if (e.user.displayName) u.displayName = e.user.displayName;
      map.set(e.user.id, u);
    }
    return Array.from(map.values()).sort((a, b) => b.events - a.events);
  }
}

/**
 * Instant comparison for ISO timestamps.
 *
 * Never compare ISO strings lexicographically: `"…:40Z"` sorts *after*
 * `"…:40.821Z"` because "Z" > ".", so a timestamp without milliseconds (what
 * Graph and most clients send) would silently fall outside a window whose bound
 * has them. The SQL repository compares real `timestamptz` values; this keeps
 * the in-memory implementation faithful to it.
 */
const instant = (v: string | undefined): number => {
  if (!v) return Number.NaN;
  const t = Date.parse(v);
  return Number.isNaN(t) ? Number.NaN : t;
};

/** `value` is within [from, to) — an absent bound means "unbounded". */
const withinWindow = (value: string | undefined, from?: string, to?: string, exclusiveEnd = false): boolean => {
  const v = instant(value);
  if (Number.isNaN(v)) return !from && !to;
  if (from !== undefined) {
    const f = instant(from);
    if (!Number.isNaN(f) && v < f) return false;
  }
  if (to !== undefined) {
    const t = instant(to);
    if (!Number.isNaN(t) && (exclusiveEnd ? v >= t : v > t)) return false;
  }
  return true;
};

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

export class MemoryEmailIndexRepository implements EmailIndexRepository {
  /** key = userId|emailId */
  readonly chunks = new Map<string, IndexedChunk[]>();

  async upsertEmail(userId: string, chunks: IndexedChunk[]): Promise<void> {
    const emailId = chunks[0]?.emailId;
    if (!emailId) return;
    this.chunks.set(`${userId}|${emailId}`, clone(chunks));
  }
  private forUser(userId: string, filter: IndexSearchFilter): IndexedChunk[] {
    const out: IndexedChunk[] = [];
    for (const [key, list] of this.chunks) {
      if (!key.startsWith(`${userId}|`)) continue;
      for (const c of list) {
        if (filter.conversationId && c.conversationId !== filter.conversationId) continue;
        if (filter.folder && (c.folder ?? "").toLowerCase() !== filter.folder.toLowerCase()) continue;
        if ((filter.from || filter.to) && !withinWindow(c.receivedAt, filter.from, filter.to)) continue;
        out.push(c);
      }
    }
    return out;
  }
  async searchLexical(userId: string, query: string, filter: IndexSearchFilter, limit: number): Promise<IndexHit[]> {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    const hits: IndexHit[] = [];
    for (const c of this.forUser(userId, filter)) {
      const hay = tokenize(`${c.subject} ${c.bodyText}`);
      const set = new Set(hay);
      let score = 0;
      for (const t of terms) {
        if (set.has(t)) score += 1;
        else if (t.length >= 5 && hay.some((h) => h.startsWith(t.slice(0, 5)))) score += 0.5; // crude stemming
      }
      if (score > 0) hits.push({ chunk: clone(c), score: score / terms.length + (c.subject.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async searchVector(userId: string, embedding: number[], filter: IndexSearchFilter, limit: number): Promise<IndexHit[]> {
    const hits: IndexHit[] = [];
    for (const c of this.forUser(userId, filter)) {
      if (!c.embedding) continue;
      const score = cosine(embedding, c.embedding);
      if (score > 0) hits.push({ chunk: clone(c), score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async supportsVectors(): Promise<boolean> {
    return true;
  }
  async listRecent(userId: string, filter: { fromAddress?: string; fromDomain?: string; subjectContains?: string; hasAttachments?: boolean }, limit: number): Promise<IndexedChunk[]> {
    const firsts = this.forUser(userId, {}).filter((c) => c.chunkNo === 0);
    return firsts
      .filter((c) => !filter.fromAddress || (c.fromAddress ?? "").toLowerCase() === filter.fromAddress.toLowerCase())
      .filter((c) => !filter.fromDomain || emailDomain(c.fromAddress ?? "") === filter.fromDomain.toLowerCase() || emailDomain(c.fromAddress ?? "").endsWith(`.${filter.fromDomain.toLowerCase()}`))
      .filter((c) => !filter.subjectContains || c.subject.toLowerCase().includes(filter.subjectContains.toLowerCase()))
      .filter((c) => filter.hasAttachments === undefined || Boolean(c.hasAttachments) === filter.hasAttachments)
      .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""))
      .slice(0, limit)
      .map(clone);
  }
  async hasEmail(userId: string, emailId: string): Promise<boolean> {
    return (this.chunks.get(`${userId}|${emailId}`)?.length ?? 0) > 0;
  }
  async count(userId: string): Promise<number> {
    let n = 0;
    for (const key of this.chunks.keys()) if (key.startsWith(`${userId}|`)) n++;
    return n;
  }
  async listReceivedBetween(userId: string, fromIso: string, toIso: string, limit: number): Promise<IndexedChunk[]> {
    return this.forUser(userId, {})
      .filter((c) => c.chunkNo === 0)
      .filter((c) => withinWindow(c.receivedAt, fromIso, toIso, true))
      .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""))
      .slice(0, limit)
      .map(clone);
  }
  async purgeOlderThan(beforeIso: string): Promise<number> {
    const cutoff = instant(beforeIso);
    let n = 0;
    for (const [key, list] of this.chunks) {
      const newest = list.reduce((acc, c) => Math.max(acc, instant(c.receivedAt) || 0), 0);
      if (newest > 0 && newest < cutoff) {
        this.chunks.delete(key);
        n += list.length;
      }
    }
    return n;
  }
}

export class MemoryChatRepository implements ChatRepository {
  readonly sessions = new Map<string, ChatSession>();
  readonly messages = new Map<string, ChatMessage[]>();
  async createSession(session: ChatSession): Promise<void> {
    this.sessions.set(session.id, clone(session));
    this.messages.set(session.id, []);
  }
  async getSession(id: string): Promise<ChatSession | undefined> {
    const s = this.sessions.get(id);
    return s ? clone(s) : undefined;
  }
  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    this.messages.get(sessionId)?.push(clone(message));
  }
  async listMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    return clone((this.messages.get(sessionId) ?? []).slice(-limit));
  }
  async touch(sessionId: string, updatedAt: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.updatedAt = updatedAt;
  }
}

export class MemoryActionRepository implements ActionRepository {
  readonly proposals = new Map<string, StoredProposal>();
  async saveProposal(proposal: StoredProposal): Promise<void> {
    this.proposals.set(proposal.id, clone(proposal));
  }
  async getProposal(id: string): Promise<StoredProposal | undefined> {
    const p = this.proposals.get(id);
    return p ? clone(p) : undefined;
  }
  async getAction(actionId: string): Promise<StoredAction | undefined> {
    for (const p of this.proposals.values()) {
      const a = p.actions.find((x) => x.action.id === actionId);
      if (a) return clone(a);
    }
    return undefined;
  }
  async updateAction(actionId: string, status: StoredAction["status"], message: string | undefined, updatedAt: string): Promise<void> {
    for (const p of this.proposals.values()) {
      const a = p.actions.find((x) => x.action.id === actionId);
      if (a) {
        a.status = status;
        a.message = message;
        a.updatedAt = updatedAt;
      }
    }
  }
}

export class MemoryEscalationRepository implements EscalationRepository {
  readonly items = new Map<string, StoredEscalation>();
  async create(e: StoredEscalation): Promise<void> {
    this.items.set(e.id, clone(e));
  }
  async get(id: string): Promise<StoredEscalation | undefined> {
    const e = this.items.get(id);
    return e ? clone(e) : undefined;
  }
  async list(filter: { userId?: string; status?: Escalation["status"] }): Promise<StoredEscalation[]> {
    return clone(
      Array.from(this.items.values())
        .filter((e) => !filter.userId || e.userId === filter.userId)
        .filter((e) => !filter.status || e.status === filter.status)
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    );
  }
  async update(e: StoredEscalation): Promise<void> {
    this.items.set(e.id, clone(e));
  }
}

export class MemoryAutomationRepository implements AutomationRepository {
  readonly items = new Map<string, StoredAutomation>();
  async save(a: StoredAutomation): Promise<void> {
    this.items.set(a.id, clone(a));
  }
  async get(id: string): Promise<StoredAutomation | undefined> {
    const a = this.items.get(id);
    return a ? clone(a) : undefined;
  }
  async list(userId?: string): Promise<StoredAutomation[]> {
    return clone(Array.from(this.items.values()).filter((a) => !userId || a.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  async findByFingerprint(userId: string, fingerprint: string): Promise<StoredAutomation | undefined> {
    const a = Array.from(this.items.values()).find((x) => x.userId === userId && x.fingerprint === fingerprint);
    return a ? clone(a) : undefined;
  }
}

export class MemoryUserActionEventRepository implements UserActionEventRepository {
  readonly events: StoredUserActionEvent[] = [];
  async append(events: StoredUserActionEvent[]): Promise<void> {
    this.events.push(...clone(events));
  }
  async listSince(userId: string, sinceIso: string): Promise<StoredUserActionEvent[]> {
    return clone(this.events.filter((e) => e.userId === userId && e.occurredAt >= sinceIso).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)));
  }
}

export class MemoryPolicyRepository implements PolicyRepository {
  private policy: Policy | undefined;
  async get(): Promise<Policy | undefined> {
    return this.policy ? clone(this.policy) : undefined;
  }
  async put(policy: Policy): Promise<void> {
    this.policy = clone(policy);
  }
}

export class MemoryFeedbackRepository implements FeedbackRepository {
  readonly items: FeedbackRecord[] = [];
  async save(f: FeedbackRecord): Promise<void> {
    this.items.push(clone(f));
  }
}

export interface MemoryRepositories extends Repositories {
  analysisCache: MemoryAnalysisCacheRepository;
  embeddingCache: MemoryEmbeddingCacheRepository;
  mailboxSync: MemoryMailboxSyncRepository;
  dailyBriefs: MemoryDailyBriefRepository;
  idempotency: MemoryIdempotencyRepository;
  audit: MemoryAuditRepository;
  emailIndex: MemoryEmailIndexRepository;
  chat: MemoryChatRepository;
  actions: MemoryActionRepository;
  escalations: MemoryEscalationRepository;
  automations: MemoryAutomationRepository;
  userActionEvents: MemoryUserActionEventRepository;
  policy: MemoryPolicyRepository;
  feedback: MemoryFeedbackRepository;
}

export function createMemoryRepositories(): MemoryRepositories {
  return {
    audit: new MemoryAuditRepository(),
    emailIndex: new MemoryEmailIndexRepository(),
    chat: new MemoryChatRepository(),
    actions: new MemoryActionRepository(),
    escalations: new MemoryEscalationRepository(),
    automations: new MemoryAutomationRepository(),
    userActionEvents: new MemoryUserActionEventRepository(),
    policy: new MemoryPolicyRepository(),
    feedback: new MemoryFeedbackRepository(),
    analysisCache: new MemoryAnalysisCacheRepository(),
    embeddingCache: new MemoryEmbeddingCacheRepository(),
    mailboxSync: new MemoryMailboxSyncRepository(),
    dailyBriefs: new MemoryDailyBriefRepository(),
    idempotency: new MemoryIdempotencyRepository(),
    ping: async () => ({ ok: true, detail: "in-memory repositories" }),
    close: async () => undefined,
  };
}

export { MemoryAnalysisCacheRepository, MemoryDailyBriefRepository, MemoryEmbeddingCacheRepository, MemoryIdempotencyRepository, MemoryMailboxSyncRepository } from "./caches.js";

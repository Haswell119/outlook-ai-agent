import type {
  ActionResultStatus,
  AuditEvent,
  AuditQuery,
  Automation,
  ChatMessage,
  DailyBrief,
  EmailAnalysis,
  Escalation,
  Policy,
  ProposedAction,
  UserActionEvent,
  EmailContext,
} from "@oao/shared";

/* ----------------------------- Audit ----------------------------------- */

export interface AuditAggregates {
  /** Event counts by type in the requested period. */
  countsByType: Record<string, number>;
  /** Event counts by type in the previous period of the same length. */
  previousCountsByType: Record<string, number>;
  /** Daily counts by type (date = YYYY-MM-DD). */
  daily: Array<{ date: string; type: string; count: number }>;
  /** Compliance issue codes seen in compliance_alert / compliance_check events. */
  complianceByCategory: Array<{ category: string; count: number }>;
  topUsers: Array<{ userId: string; displayName: string; actions: number }>;
  total: number;
}

export interface AuditUserSummary {
  userId: string;
  email: string;
  displayName?: string;
  events: number;
  lastActivity: string;
}

/** Keyset cursor for the streaming CSV export (stable under concurrent writes). */
export interface AuditCursor {
  /** Timestamp of the last row returned. */
  timestamp: string;
  /** Id of the last row returned (tie-break). */
  id: string;
}

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  get(id: string): Promise<AuditEvent | undefined>;
  query(q: AuditQuery): Promise<{ items: AuditEvent[]; total: number }>;
  /** All matching events (for CSV export), capped at `limit`. */
  list(q: Omit<AuditQuery, "page" | "pageSize">, limit: number): Promise<AuditEvent[]>;
  /**
   * One page of matching events, newest first, strictly after `cursor`.
   * Used by `GET /audit/export` to stream the CSV instead of buffering it.
   */
  listPage(q: Omit<AuditQuery, "page" | "pageSize">, limit: number, cursor?: AuditCursor): Promise<AuditEvent[]>;
  aggregates(from: string, to: string): Promise<AuditAggregates>;
  users(): Promise<AuditUserSummary[]>;
  /** Retention: delete events strictly older than `beforeIso`. Returns the row count. */
  purgeOlderThan(beforeIso: string): Promise<number>;
  /** Event counts by type (all time) — exposed as a Prometheus gauge. */
  countsByType(): Promise<Record<string, number>>;
}

/* --------------------------- Email index ------------------------------- */

export interface IndexedChunk {
  userId: string;
  emailId: string;
  conversationId?: string;
  internetMessageId?: string;
  subject: string;
  fromName?: string;
  fromAddress?: string;
  receivedAt?: string;
  folder?: string;
  webLink?: string;
  hasAttachments?: boolean;
  attachmentNames?: string[];
  chunkNo: number;
  bodyText: string;
  embedding?: number[];
}

export interface IndexSearchFilter {
  conversationId?: string;
  folder?: string;
  from?: string;
  to?: string;
}

export interface IndexHit {
  chunk: IndexedChunk;
  score: number;
}

export interface EmailIndexRepository {
  /** Replaces every chunk of the email (upsert by user_id + email_id). */
  upsertEmail(userId: string, chunks: IndexedChunk[]): Promise<void>;
  searchLexical(userId: string, query: string, filter: IndexSearchFilter, limit: number): Promise<IndexHit[]>;
  searchVector(userId: string, embedding: number[], filter: IndexSearchFilter, limit: number): Promise<IndexHit[]>;
  /** Whether vector search is possible (pgvector column present **and** its dimension matches the configuration). */
  supportsVectors(): Promise<boolean>;
  /**
   * Declared dimension of the embedding column: a number, `null` when the
   * column accepts any size, `undefined` when there is no vector column.
   * Optional — only the Postgres adapter can answer it.
   */
  vectorDimensions?(): Promise<number | null | undefined>;
  /** Most recent indexed emails (first chunk only) matching a simple filter. */
  listRecent(userId: string, filter: { fromAddress?: string; fromDomain?: string; subjectContains?: string; hasAttachments?: boolean }, limit: number): Promise<IndexedChunk[]>;
  count(userId: string): Promise<number>;
  /** Whether at least one chunk of this email is stored for the user (auto-index dedup). */
  hasEmail(userId: string, emailId: string): Promise<boolean>;
  /** First chunk of every email received in `[fromIso, toIso)` (daily brief input). */
  listReceivedBetween(userId: string, fromIso: string, toIso: string, limit: number): Promise<IndexedChunk[]>;
  /** Retention: delete chunks whose `received_at` (or `indexed_at`) is older than `beforeIso`. */
  purgeOlderThan(beforeIso: string): Promise<number>;
}

/* ------------------------------- Chat ---------------------------------- */

export interface ChatSession {
  id: string;
  userId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRepository {
  createSession(session: ChatSession): Promise<void>;
  getSession(id: string): Promise<ChatSession | undefined>;
  appendMessage(sessionId: string, message: ChatMessage & { auditId?: string }): Promise<void>;
  listMessages(sessionId: string, limit: number): Promise<ChatMessage[]>;
  touch(sessionId: string, updatedAt: string): Promise<void>;
}

/* ------------------------------ Actions -------------------------------- */

export interface StoredProposal {
  id: string;
  userId: string;
  auditId: string;
  emailId?: string;
  conversationId?: string;
  createdAt: string;
  expiresAt: string;
  actions: StoredAction[];
}

export interface StoredAction {
  action: ProposedAction;
  proposalId: string;
  status: ActionResultStatus | "proposed" | "cancelled";
  message?: string;
  updatedAt: string;
}

export interface ActionRepository {
  saveProposal(proposal: StoredProposal): Promise<void>;
  getProposal(id: string): Promise<StoredProposal | undefined>;
  getAction(actionId: string): Promise<StoredAction | undefined>;
  updateAction(actionId: string, status: StoredAction["status"], message: string | undefined, updatedAt: string): Promise<void>;
}

/* ---------------------------- Escalations ------------------------------ */

export interface StoredEscalation extends Omit<Escalation, "draft"> {
  userId: string;
  actionId?: string;
  /** Raw draft as received (validated with ComposeContextSchema when exposed). */
  draft?: unknown;
}

export interface EscalationRepository {
  create(e: StoredEscalation): Promise<void>;
  get(id: string): Promise<StoredEscalation | undefined>;
  list(filter: { userId?: string; status?: Escalation["status"] }): Promise<StoredEscalation[]>;
  update(e: StoredEscalation): Promise<void>;
}

/* ---------------------------- Automations ------------------------------ */

export interface StoredAutomation extends Automation {
  userId: string;
  /** Fingerprint of trigger + step types used to avoid duplicate proposals. */
  fingerprint: string;
}

export interface AutomationRepository {
  save(a: StoredAutomation): Promise<void>;
  get(id: string): Promise<StoredAutomation | undefined>;
  list(userId?: string): Promise<StoredAutomation[]>;
  findByFingerprint(userId: string, fingerprint: string): Promise<StoredAutomation | undefined>;
}

export interface StoredUserActionEvent extends UserActionEvent {
  id: string;
  userId: string;
}

export interface UserActionEventRepository {
  append(events: StoredUserActionEvent[]): Promise<void>;
  listSince(userId: string, sinceIso: string): Promise<StoredUserActionEvent[]>;
}

/* ------------------------------ Policy --------------------------------- */

export interface PolicyRepository {
  get(): Promise<Policy | undefined>;
  put(policy: Policy): Promise<void>;
}

/* ----------------------------- Feedback -------------------------------- */

export interface FeedbackRecord {
  id: string;
  auditId: string;
  userId: string;
  rating: "up" | "down";
  comment?: string;
  createdAt: string;
}

export interface FeedbackRepository {
  save(f: FeedbackRecord): Promise<void>;
}

/** All repositories bundled (composition root). */
export interface Repositories extends ExtendedRepositories {
  audit: AuditRepository;
  emailIndex: EmailIndexRepository;
  chat: ChatRepository;
  actions: ActionRepository;
  escalations: EscalationRepository;
  automations: AutomationRepository;
  userActionEvents: UserActionEventRepository;
  policy: PolicyRepository;
  feedback: FeedbackRepository;
  /** Liveness probe for /health. */
  ping(timeoutMs: number): Promise<{ ok: boolean; detail?: string }>;
  close(): Promise<void>;
}

/** Convenience re-export so services import only from ports. */
export type { EmailContext };

/* --------------------------- Analysis cache ---------------------------- */

/**
 * Content-hash cache of model answers (AI-load minimisation). `key` comes from
 * `domain/cacheKey.ts`; the same key must always mean the same answer, so the
 * prompt version is baked into it.
 */
export type AnalysisCacheKind = "analysis" | "thread" | "draft";

export interface AnalysisCacheEntry<T = unknown> {
  key: string;
  kind: AnalysisCacheKind;
  /** Owner. Analyses are scoped per user so one mailbox can never read another's. */
  userId: string;
  /** Email / conversation the entry describes (lets `GET /analyze/email/:id` find it). */
  emailId?: string;
  conversationId?: string;
  value: T;
  model?: string;
  /** `precomputed` when produced by the sync worker, `llm` when produced on demand. */
  origin: "llm" | "precomputed" | "heuristic";
  createdAt: string;
  expiresAt: string;
}

export interface AnalysisCacheRepository {
  get<T>(userId: string, key: string): Promise<AnalysisCacheEntry<T> | undefined>;
  put<T>(entry: AnalysisCacheEntry<T>): Promise<void>;
  /** Newest non-expired analysis of one email (used by `GET /analyze/email/:id`). */
  getByEmail<T>(userId: string, emailId: string): Promise<AnalysisCacheEntry<T> | undefined>;
  /** Non-expired analyses written *ahead of time* by the worker (sync status). */
  countPrecomputed(userId: string): Promise<number>;
  purgeExpired(nowIso: string): Promise<number>;
}

/* --------------------------- Embedding cache --------------------------- */

export interface EmbeddingCacheRepository {
  /** Vectors already known for these (model, chunk-hash) pairs. */
  getMany(model: string, keys: string[]): Promise<Map<string, number[]>>;
  putMany(model: string, entries: Array<{ key: string; embedding: number[] }>, expiresAt: string): Promise<void>;
  purgeExpired(nowIso: string): Promise<number>;
  count(): Promise<number>;
}

/* ---------------------------- Mailbox sync ----------------------------- */

/** Per-user delta state of the precomputation worker. */
export interface MailboxSyncState {
  userId: string;
  userEmail: string;
  /** Graph delta token for `/me/mailFolders/inbox/messages/delta`. */
  deltaToken?: string;
  state: "idle" | "syncing" | "error" | "disabled";
  lastSyncAt?: string;
  nextSyncAt?: string;
  lastError?: string;
  indexedEmails: number;
  precomputedAnalyses: number;
  /** Messages seen but not yet analysed (backlog). */
  pending: number;
  /** How the worker can reach this mailbox. */
  authMode: "obo" | "app";
  /** Home account id of the MSAL token cache entry (delegated mode). */
  msalHomeAccountId?: string;
  updatedAt: string;
}

export interface MailboxSyncRepository {
  get(userId: string): Promise<MailboxSyncState | undefined>;
  put(state: MailboxSyncState): Promise<void>;
  list(): Promise<MailboxSyncState[]>;
  /** States whose `nextSyncAt` is due (or unset), oldest first. */
  listDue(nowIso: string, limit: number): Promise<MailboxSyncState[]>;
}

/* ----------------------------- Daily brief ----------------------------- */

export interface DailyBriefRepository {
  get(userId: string, date: string): Promise<DailyBrief | undefined>;
  put(userId: string, brief: DailyBrief): Promise<void>;
  /** Retention: delete briefs older than `beforeDate` (YYYY-MM-DD). */
  purgeOlderThan(beforeDate: string): Promise<number>;
}

/* ---------------------------- Idempotency ------------------------------ */

/** `Idempotency-Key` records for `POST /actions/approve` (24 h by default). */
export interface IdempotencyRecord {
  key: string;
  userId: string;
  /** Route + body fingerprint: replaying a key with a different body is a conflict. */
  requestHash: string;
  response: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface IdempotencyRepository {
  get(userId: string, key: string): Promise<IdempotencyRecord | undefined>;
  put(record: IdempotencyRecord): Promise<void>;
  purgeExpired(nowIso: string): Promise<number>;
}

/** Repositories added for production hardening / AI-load minimisation. */
export interface ExtendedRepositories {
  analysisCache: AnalysisCacheRepository;
  embeddingCache: EmbeddingCacheRepository;
  mailboxSync: MailboxSyncRepository;
  dailyBriefs: DailyBriefRepository;
  idempotency: IdempotencyRepository;
}

/** Shape stored in the analysis cache (the public contract plus its origin). */
export type CachedAnalysis = EmailAnalysis;

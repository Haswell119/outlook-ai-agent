import type {
  ActionResultStatus,
  AuditEvent,
  AuditQuery,
  Automation,
  ChatMessage,
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

export interface AuditRepository {
  append(event: AuditEvent): Promise<void>;
  get(id: string): Promise<AuditEvent | undefined>;
  query(q: AuditQuery): Promise<{ items: AuditEvent[]; total: number }>;
  /** All matching events (for CSV export), capped at `limit`. */
  list(q: Omit<AuditQuery, "page" | "pageSize">, limit: number): Promise<AuditEvent[]>;
  aggregates(from: string, to: string): Promise<AuditAggregates>;
  users(): Promise<AuditUserSummary[]>;
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
  /** Whether vector search is possible (pgvector column present). */
  supportsVectors(): Promise<boolean>;
  /** Most recent indexed emails (first chunk only) matching a simple filter. */
  listRecent(userId: string, filter: { fromAddress?: string; fromDomain?: string; subjectContains?: string; hasAttachments?: boolean }, limit: number): Promise<IndexedChunk[]>;
  count(userId: string): Promise<number>;
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

export interface StoredEscalation extends Escalation {
  userId: string;
  actionId?: string;
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
export interface Repositories {
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

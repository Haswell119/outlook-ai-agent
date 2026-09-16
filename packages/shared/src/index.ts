/**
 * @oao/shared — API contracts shared by the Outlook add-in, the AI Orchestrator
 * backend and the admin dashboard.
 *
 * Every HTTP payload crossing a process boundary is described here with zod so
 * that the three apps are always compiled against the same contract.
 *
 * Conventions
 *  - All endpoints live under `/api/v1`.
 *  - All timestamps are ISO-8601 strings (UTC).
 *  - All identifiers are opaque strings.
 *  - Language codes are BCP-47 (`fr`, `en`).
 */
import { z } from "zod";

/* ------------------------------------------------------------------------- */
/*  Primitives                                                               */
/* ------------------------------------------------------------------------- */

/**
 * `webLink` is a deep link the UI opens with `window.open`. It reaches us as a
 * plain string from Office.js or from Graph, so a `javascript:` or `data:` URL
 * would be script execution in the add-in's own origin the moment a user clicks
 * "Open original email". Only absolute http(s) links survive; anything else
 * becomes `undefined` and the UI falls back to `displayMessageForm(emailId)`.
 */
export function safeExternalLink(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const LanguageSchema = z.enum(["fr", "en"]);
export type Language = z.infer<typeof LanguageSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const PrioritySchema = z.enum(["low", "medium", "high"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const ConfidenceSchema = z.number().min(0).max(1);

export const EmailAddressSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});
export type EmailAddress = z.infer<typeof EmailAddressSchema>;

export const AttachmentMetaSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  size: z.number().int().nonnegative().optional(),
  contentType: z.string().optional(),
  isInline: z.boolean().optional(),
  /** Optional extracted text (only sent when the add-in / Graph extracted it). */
  textContent: z.string().optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/**
 * The email as seen from the add-in (Office.js) or from Microsoft Graph.
 * `body` is plain text (HTML already stripped by the sender).
 */
export const EmailContextSchema = z.object({
  /** Office.js itemId or Graph message id. */
  id: z.string(),
  /** Graph conversationId (or Office.js conversationId). */
  conversationId: z.string().optional(),
  internetMessageId: z.string().optional(),
  subject: z.string().default(""),
  from: EmailAddressSchema.optional(),
  to: z.array(EmailAddressSchema).default([]),
  cc: z.array(EmailAddressSchema).default([]),
  bcc: z.array(EmailAddressSchema).default([]),
  receivedAt: z.string().optional(),
  sentAt: z.string().optional(),
  body: z.string().default(""),
  bodyPreview: z.string().optional(),
  attachments: z.array(AttachmentMetaSchema).default([]),
  categories: z.array(z.string()).default([]),
  importance: z.enum(["low", "normal", "high"]).optional(),
  isRead: z.boolean().optional(),
  folder: z.string().optional(),
  /** Deep link to open the message in Outlook (Graph `webLink`). */
  webLink: z.string().optional(),
  /** Optional sensitivity / classification label already applied. */
  sensitivityLabel: z.string().optional(),
});
export type EmailContext = z.infer<typeof EmailContextSchema>;

export const ThreadContextSchema = z.object({
  conversationId: z.string(),
  subject: z.string().default(""),
  messages: z.array(EmailContextSchema).min(1),
});
export type ThreadContext = z.infer<typeof ThreadContextSchema>;

/* ------------------------------------------------------------------------- */
/*  Auth / identity                                                          */
/* ------------------------------------------------------------------------- */

export const UserIdentitySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().optional(),
  tenantId: z.string().optional(),
  roles: z.array(z.enum(["user", "compliance", "admin"])).default(["user"]),
});
export type UserIdentity = z.infer<typeof UserIdentitySchema>;

/* ------------------------------------------------------------------------- */
/*  1. Lecture assistée — email analysis                                     */
/* ------------------------------------------------------------------------- */

export const ActionTypeSchema = z.enum([
  "draft_reply",
  "create_reminder",
  "create_task",
  "categorize",
  "archive",
  "move_to_folder",
  "flag",
  "apply_label",
  "notify",
  "request_document",
  "escalate_compliance",
  "classify_email",
  "remove_attachment",
  "request_approval",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const SuggestedActionSchema = z.object({
  type: ActionTypeSchema,
  title: z.string(),
  description: z.string(),
  /** Free-form parameters understood by the action executor (see docs/ACTIONS.md). */
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

export const DetectedRiskSchema = z.object({
  code: z.string(),
  title: z.string(),
  description: z.string().optional(),
  severity: RiskLevelSchema,
});
export type DetectedRisk = z.infer<typeof DetectedRiskSchema>;

export const EmailAnalysisSchema = z.object({
  emailId: z.string(),
  language: LanguageSchema,
  summary: z.string(),
  decisions: z.array(z.string()),
  pendingTasks: z.array(z.string()),
  risks: z.array(DetectedRiskSchema),
  suggestedActions: z.array(SuggestedActionSchema),
  quickReplies: z.array(z.string()).max(4).default([]),
  /** Category suggestion (project / client / type). */
  classification: z
    .object({ category: z.string(), confidence: ConfidenceSchema })
    .optional(),
  confidence: ConfidenceSchema,
  /** Phishing screening (Compliance Guardian, inbound). */
  phishing: z
    .object({
      score: ConfidenceSchema,
      verdict: z.enum(["clean", "suspicious", "likely_phishing"]),
      indicators: z.array(z.string()),
    })
    .optional(),
  auditId: z.string(),
  generatedAt: z.string(),
  model: z.string().optional(),
  /**
   * How the analysis was produced (AI-load minimisation):
   *  - `llm`         : model called for this request
   *  - `cache`       : identical content already analysed (content-hash cache)
   *  - `precomputed` : analysed ahead of time by the mailbox sync worker
   *  - `heuristic`   : rules only (trivial/automatic email, or model unavailable)
   */
  source: z.enum(["llm", "cache", "precomputed", "heuristic"]).optional(),
  /** Set when the email was classified as not worth a model call (newsletter, notification, OOO…). */
  triage: z
    .object({ kind: z.enum(["conversation", "notification", "newsletter", "out_of_office", "automatic", "calendar", "trivial"]), reason: z.string().optional() })
    .optional(),
});
export type EmailAnalysis = z.infer<typeof EmailAnalysisSchema>;

export const AnalyzeEmailRequestSchema = z.object({
  email: EmailContextSchema,
  language: LanguageSchema.optional(),
  /** When true the orchestrator may fetch the whole thread via Graph. */
  includeThread: z.boolean().default(false),
});
export type AnalyzeEmailRequest = z.infer<typeof AnalyzeEmailRequestSchema>;

/* ------------------------------------------------------------------------- */
/*  2. Synthèse opérationnelle — thread synthesis                            */
/* ------------------------------------------------------------------------- */

export const OpenTaskSchema = z.object({
  title: z.string(),
  owner: z.string().optional(),
  priority: PrioritySchema.default("medium"),
  dueDate: z.string().optional(),
  done: z.boolean().default(false),
  /** Highlighted when it is the critical / blocking task. */
  critical: z.boolean().default(false),
});
export type OpenTask = z.infer<typeof OpenTaskSchema>;

export const DeadlineSchema = z.object({
  title: z.string(),
  date: z.string().optional(),
  description: z.string().optional(),
  atRisk: z.boolean().default(false),
});
export type Deadline = z.infer<typeof DeadlineSchema>;

export const MissingDocumentSchema = z.object({
  name: z.string(),
  requestedOn: z.string().optional(),
  requestedFrom: z.string().optional(),
});
export type MissingDocument = z.infer<typeof MissingDocumentSchema>;

export const ThreadSynthesisSchema = z.object({
  conversationId: z.string(),
  language: LanguageSchema,
  executiveSummary: z.string(),
  missingDocuments: z.array(MissingDocumentSchema),
  decisions: z.array(z.string()),
  openTasks: z.array(OpenTaskSchema),
  deadlines: z.array(DeadlineSchema),
  risks: z.array(DetectedRiskSchema),
  recommendedActions: z.array(SuggestedActionSchema),
  recommendedNextStep: z
    .object({ title: z.string(), description: z.string(), action: SuggestedActionSchema.optional() })
    .optional(),
  sources: z.array(z.object({ emailId: z.string(), subject: z.string(), from: z.string().optional(), date: z.string().optional() })),
  confidence: ConfidenceSchema,
  auditId: z.string(),
  generatedAt: z.string(),
  model: z.string().optional(),
});
export type ThreadSynthesis = z.infer<typeof ThreadSynthesisSchema>;

export const AnalyzeThreadRequestSchema = z.object({
  thread: ThreadContextSchema,
  language: LanguageSchema.optional(),
});
export type AnalyzeThreadRequest = z.infer<typeof AnalyzeThreadRequestSchema>;

/* ------------------------------------------------------------------------- */
/*  3. Brouillon de réponse — draft reply (never sent by the AI)             */
/* ------------------------------------------------------------------------- */

export const DraftIntentSchema = z.enum(["accept", "decline", "acknowledge", "follow_up", "request_info", "custom"]);
export type DraftIntent = z.infer<typeof DraftIntentSchema>;

export const DraftReplyRequestSchema = z.object({
  email: EmailContextSchema,
  thread: ThreadContextSchema.optional(),
  intent: DraftIntentSchema.default("custom"),
  instructions: z.string().optional(),
  tone: z.enum(["formal", "neutral", "friendly"]).default("formal"),
  language: LanguageSchema.optional(),
});
export type DraftReplyRequest = z.infer<typeof DraftReplyRequestSchema>;

export const DraftReplySchema = z.object({
  subject: z.string(),
  /** Plain-text body. The add-in converts it to HTML for Office.js. */
  body: z.string(),
  language: LanguageSchema,
  confidence: ConfidenceSchema,
  auditId: z.string(),
  model: z.string().optional(),
});
export type DraftReply = z.infer<typeof DraftReplySchema>;

/* ------------------------------------------------------------------------- */
/*  4. Recherche conversationnelle & chat                                    */
/* ------------------------------------------------------------------------- */

export const SearchSourceSchema = z.object({
  emailId: z.string(),
  conversationId: z.string().optional(),
  subject: z.string(),
  from: z.string().optional(),
  date: z.string().optional(),
  /** 0..1 relevance score. */
  relevance: ConfidenceSchema,
  /** Best matching excerpt (plain text). */
  excerpt: z.string(),
  webLink: z.string().optional(),
});
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  /** Restrict to a conversation. */
  conversationId: z.string().optional(),
  /** Restrict to a date window. */
  from: z.string().optional(),
  to: z.string().optional(),
});
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchResponseSchema = z.object({
  query: z.string(),
  results: z.array(SearchSourceSchema),
  /** "hybrid" (vector + lexical), "lexical" (no embedding model configured). */
  mode: z.enum(["hybrid", "lexical", "vector"]),
  auditId: z.string(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  sources: z.array(SearchSourceSchema).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  sessionId: z.string().optional(),
  message: z.string().min(1),
  /** Current email opened in Outlook, if any (gives the chat its context). */
  currentEmail: EmailContextSchema.optional(),
  /** Scope of the retrieval. */
  scope: z
    .object({
      conversationId: z.string().optional(),
      folder: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .default({}),
  language: LanguageSchema.optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({
  sessionId: z.string(),
  answer: z.string(),
  /** Short headline such as "Client approval detected". */
  headline: z.string().optional(),
  sources: z.array(SearchSourceSchema),
  /** Evidence quoted from the top source. */
  evidence: z
    .object({ emailId: z.string(), subject: z.string(), quote: z.string(), author: z.string().optional(), date: z.string().optional(), webLink: z.string().optional() })
    .optional(),
  confidence: ConfidenceSchema,
  auditId: z.string(),
  model: z.string().optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const IndexEmailsRequestSchema = z.object({
  emails: z.array(EmailContextSchema).min(1).max(200),
});
export type IndexEmailsRequest = z.infer<typeof IndexEmailsRequestSchema>;

export const IndexEmailsResponseSchema = z.object({
  indexed: z.number().int(),
  skipped: z.number().int(),
  mode: z.enum(["hybrid", "lexical"]),
});
export type IndexEmailsResponse = z.infer<typeof IndexEmailsResponseSchema>;

/* ------------------------------------------------------------------------- */
/*  5. Human-in-the-loop — proposed / approved actions                       */
/* ------------------------------------------------------------------------- */

/**
 * Where an action is executed:
 *  - `client`: executed by the add-in with Office.js (e.g. displayReplyForm, categories)
 *  - `server`: executed by the orchestrator via Microsoft Graph / internal connectors
 *  - `none`  : informational only (e.g. notify) — logged, no side effect
 */
export const ExecutionTargetSchema = z.enum(["client", "server", "none"]);
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const ProposedActionSchema = z.object({
  id: z.string(),
  type: ActionTypeSchema,
  title: z.string(),
  explanation: z.string(),
  source: z.object({
    kind: z.enum(["email", "attachment", "rule", "thread"]),
    label: z.string(),
    detail: z.string().optional(),
    emailId: z.string().optional(),
  }),
  riskLevel: RiskLevelSchema,
  requiresApproval: z.boolean(),
  /** Whether compliance escalation is needed before execution. */
  requiresComplianceApproval: z.boolean().default(false),
  executionTarget: ExecutionTargetSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** Pre-selected in the approval dialog. */
  selectedByDefault: z.boolean().default(true),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ProposeActionsRequestSchema = z.object({
  email: EmailContextSchema.optional(),
  thread: ThreadContextSchema.optional(),
  /** Re-use an existing analysis instead of re-running the model. */
  analysisAuditId: z.string().optional(),
  language: LanguageSchema.optional(),
});
export type ProposeActionsRequest = z.infer<typeof ProposeActionsRequestSchema>;

export const ActionProposalSchema = z.object({
  proposalId: z.string(),
  actions: z.array(ProposedActionSchema),
  humanValidationRequired: z.literal(true),
  auditId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ApproveActionsRequestSchema = z.object({
  proposalId: z.string(),
  actionIds: z.array(z.string()).min(1),
  /** Free-text justification kept in the audit trail. */
  comment: z.string().optional(),
});
export type ApproveActionsRequest = z.infer<typeof ApproveActionsRequestSchema>;

export const ActionResultStatusSchema = z.enum([
  "executed",
  "pending_client", // add-in must execute it with Office.js
  "pending_compliance", // escalated, waiting for compliance approval
  "rejected",
  "failed",
]);
export type ActionResultStatus = z.infer<typeof ActionResultStatusSchema>;

export const ActionResultSchema = z.object({
  actionId: z.string(),
  type: ActionTypeSchema,
  status: ActionResultStatusSchema,
  message: z.string().optional(),
  /** Instruction for the add-in when status === pending_client. */
  clientInstruction: z
    .object({ operation: z.string(), parameters: z.record(z.string(), z.unknown()).default({}) })
    .optional(),
  auditId: z.string(),
});
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const ApproveActionsResponseSchema = z.object({
  proposalId: z.string(),
  results: z.array(ActionResultSchema),
});
export type ApproveActionsResponse = z.infer<typeof ApproveActionsResponseSchema>;

/**
 * Operations the add-in executes with Office.js for `pending_client` results.
 * Parameters (all optional unless stated):
 *  - displayReplyForm / displayReplyAllForm: { htmlBody | body, subject, intent, instructions } — when no body is
 *    provided the add-in first calls `POST /draft/reply` with `intent`/`instructions`.
 *  - addCategory: { category }
 *  - flag: {}  (no Office.js API → user guidance; Graph executes it server-side when enabled)
 *  - displayNewAppointmentForm: { subject, body, start?, end?, asTask? }
 *  - openMoveDialog: { folder }
 *  - applyLabel: { label, labelId? }
 *  - removeAttachment: { attachmentId? | attachmentIds?[], name? | attachmentNames?[] } (compose only)
 *  - none: {}
 */
export const ClientOperationSchema = z.enum([
  "displayReplyForm",
  "displayReplyAllForm",
  "addCategory",
  "flag",
  "displayNewAppointmentForm",
  "openMoveDialog",
  "applyLabel",
  "removeAttachment",
  "none",
]);
export type ClientOperation = z.infer<typeof ClientOperationSchema>;

/** Sent by the add-in after executing a `pending_client` action. */
export const ReportActionResultRequestSchema = z.object({
  actionId: z.string(),
  status: z.enum(["executed", "failed", "cancelled"]),
  message: z.string().optional(),
});
export type ReportActionResultRequest = z.infer<typeof ReportActionResultRequestSchema>;

/* ------------------------------------------------------------------------- */
/*  6. Compliance Guardian                                                   */
/* ------------------------------------------------------------------------- */

export const ComplianceIssueCodeSchema = z.enum([
  "external_recipient",
  "confidential_attachment",
  "missing_classification_label",
  "sensitive_client_information",
  "policy_violation",
  "suspicious_recipient_domain",
  "large_distribution",
  "reply_all_external",
]);
export type ComplianceIssueCode = z.infer<typeof ComplianceIssueCodeSchema>;

export const ComplianceIssueSchema = z.object({
  id: z.string(),
  code: ComplianceIssueCodeSchema,
  title: z.string(),
  description: z.string(),
  severity: RiskLevelSchema,
  /** e.g. the recipient address or attachment name concerned. */
  subject: z.string().optional(),
});
export type ComplianceIssue = z.infer<typeof ComplianceIssueSchema>;

export const ComposeContextSchema = z.object({
  /** Office.js itemId of the draft, if available. */
  draftId: z.string().optional(),
  from: EmailAddressSchema.optional(),
  to: z.array(EmailAddressSchema).default([]),
  cc: z.array(EmailAddressSchema).default([]),
  bcc: z.array(EmailAddressSchema).default([]),
  subject: z.string().default(""),
  body: z.string().default(""),
  attachments: z.array(AttachmentMetaSchema).default([]),
  sensitivityLabel: z.string().optional(),
  isReplyAll: z.boolean().optional(),
});
export type ComposeContext = z.infer<typeof ComposeContextSchema>;

export const ComplianceCheckRequestSchema = z.object({
  draft: ComposeContextSchema,
  language: LanguageSchema.optional(),
});
export type ComplianceCheckRequest = z.infer<typeof ComplianceCheckRequestSchema>;

export const ComplianceCheckResponseSchema = z.object({
  issues: z.array(ComplianceIssueSchema),
  recommendedActions: z.array(SuggestedActionSchema),
  /** Overall verdict. `block` means the policy requires compliance approval before send. */
  verdict: z.enum(["allow", "warn", "block"]),
  confidence: ConfidenceSchema,
  auditId: z.string(),
  checkedAt: z.string(),
});
export type ComplianceCheckResponse = z.infer<typeof ComplianceCheckResponseSchema>;

export const PhishingCheckRequestSchema = z.object({ email: EmailContextSchema });
export const PhishingCheckResponseSchema = z.object({
  score: ConfidenceSchema,
  verdict: z.enum(["clean", "suspicious", "likely_phishing"]),
  indicators: z.array(z.object({ code: z.string(), description: z.string(), weight: z.number() })),
  auditId: z.string(),
});
export type PhishingCheckResponse = z.infer<typeof PhishingCheckResponseSchema>;

/** Compliance escalation (request approval from the compliance team). */
export const EscalationRequestSchema = z.object({
  reason: z.string(),
  draft: ComposeContextSchema.optional(),
  actionId: z.string().optional(),
  issues: z.array(ComplianceIssueSchema).default([]),
});
export const EscalationSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  requestedBy: z.string(),
  requestedAt: z.string(),
  reason: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  decisionComment: z.string().optional(),
  issues: z.array(ComplianceIssueSchema).default([]),
  /** Draft the escalation is about (recipients, attachments…), when it came from compose mode. */
  draft: ComposeContextSchema.optional(),
  /** Proposed action blocked until the compliance decision, when any. */
  actionId: z.string().optional(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

/** Body of `POST /compliance/escalations/:id/decision` (compliance or admin role). */
export const EscalationDecisionRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().optional(),
});
export type EscalationDecisionRequest = z.infer<typeof EscalationDecisionRequestSchema>;

/* ------------------------------------------------------------------------- */
/*  7. Automation Coach                                                      */
/* ------------------------------------------------------------------------- */

/** A user action observed by the add-in (used to detect routines). */
export const UserActionEventSchema = z.object({
  type: z.enum([
    "open_email",
    "download_attachment",
    "save_attachment",
    "move_to_folder",
    "categorize",
    "create_reminder",
    "create_task",
    "flag",
    "archive",
    "reply",
    "forward",
  ]),
  occurredAt: z.string(),
  email: z.object({
    id: z.string(),
    conversationId: z.string().optional(),
    fromAddress: z.string().optional(),
    fromDomain: z.string().optional(),
    subject: z.string().optional(),
    hasAttachments: z.boolean().optional(),
    attachmentTypes: z.array(z.string()).optional(),
  }),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type UserActionEvent = z.infer<typeof UserActionEventSchema>;

export const AutomationStepSchema = z.object({
  order: z.number().int(),
  type: ActionTypeSchema.or(z.enum(["detect_attachment", "save_attachment"])),
  title: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type AutomationStep = z.infer<typeof AutomationStepSchema>;

export const AutomationTriggerSchema = z.object({
  description: z.string(),
  conditions: z.object({
    fromAddress: z.string().optional(),
    fromDomain: z.string().optional(),
    subjectContains: z.string().optional(),
    hasAttachments: z.boolean().optional(),
    attachmentTypes: z.array(z.string()).optional(),
  }),
});
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationStatusSchema = z.enum(["proposed", "simulated", "approved", "active", "rejected", "paused"]);
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

export const AutomationSchema = z.object({
  id: z.string(),
  /** Owner (user id). Present on admin listings (`?all=true`). */
  userId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  trigger: AutomationTriggerSchema,
  steps: z.array(AutomationStepSchema),
  status: AutomationStatusSchema,
  stats: z.object({
    occurrences: z.number().int(),
    perWeek: z.number(),
    estimatedMinutesPerOccurrence: z.number(),
    estimatedMinutesSavedPerWeek: z.number(),
  }),
  confidence: ConfidenceSchema,
  riskLevel: RiskLevelSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSimulation: z
    .object({
      runAt: z.string(),
      sampleSize: z.number().int(),
      checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
      results: z.array(z.object({ emailId: z.string(), subject: z.string(), wouldApply: z.boolean(), stepsPreview: z.array(z.string()) })),
    })
    .optional(),
});
export type Automation = z.infer<typeof AutomationSchema>;

/** Body of `PATCH /automations/:id` ("Edit rule" / pause). */
export const AutomationPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  trigger: AutomationTriggerSchema.optional(),
  steps: z.array(AutomationStepSchema).optional(),
  status: z.enum(["paused", "active"]).optional(),
  comment: z.string().optional(),
});
export type AutomationPatch = z.infer<typeof AutomationPatchSchema>;

/** `GET /automations` and `POST /automations/detect` return a plain array. */
export const AutomationListSchema = z.array(AutomationSchema);

export const SimulateAutomationRequestSchema = z.object({
  sampleSize: z.number().int().min(1).max(50).default(10),
});
export const AutomationDecisionRequestSchema = z.object({
  comment: z.string().optional(),
});

/* ------------------------------------------------------------------------- */
/*  7b. Daily brief (precomputed every morning by the sync worker)           */
/* ------------------------------------------------------------------------- */

export const BriefEmailSchema = z.object({
  emailId: z.string(),
  conversationId: z.string().optional(),
  subject: z.string(),
  from: z.string().optional(),
  receivedAt: z.string().optional(),
  /** One-line reason why it matters today. */
  reason: z.string(),
  priority: PrioritySchema,
  riskLevel: RiskLevelSchema.optional(),
  webLink: z.string().optional(),
});
export type BriefEmail = z.infer<typeof BriefEmailSchema>;

export const DailyBriefSchema = z.object({
  /** ISO date (YYYY-MM-DD) in the user's timezone. */
  date: z.string(),
  language: LanguageSchema,
  headline: z.string(),
  /** 3–6 bullets: what matters today. */
  highlights: z.array(z.string()),
  priorityEmails: z.array(BriefEmailSchema),
  openTasks: z.array(OpenTaskSchema),
  deadlines: z.array(DeadlineSchema),
  /** Compliance / phishing alerts detected on inbound mail since the previous brief. */
  alerts: z.array(DetectedRiskSchema),
  stats: z.object({ newEmails: z.number().int(), analysed: z.number().int(), awaitingReply: z.number().int(), phishingSuspected: z.number().int() }),
  confidence: ConfidenceSchema,
  source: z.enum(["llm", "precomputed", "heuristic"]),
  generatedAt: z.string(),
  auditId: z.string(),
});
export type DailyBrief = z.infer<typeof DailyBriefSchema>;

/** Calendar day in the orchestrator's configured timezone. */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date (YYYY-MM-DD)");

export const DailyBriefRequestSchema = z.object({
  date: IsoDateSchema.optional(),
  language: LanguageSchema.optional(),
  /** Force regeneration even when a precomputed brief exists. */
  refresh: z.boolean().default(false),
});

/** Mailbox synchronisation / precomputation status (requires GRAPH_ENABLED). */
export const MailboxSyncStatusSchema = z.object({
  enabled: z.boolean(),
  state: z.enum(["idle", "syncing", "error", "disabled"]),
  lastSyncAt: z.string().optional(),
  nextSyncAt: z.string().optional(),
  indexedEmails: z.number().int(),
  precomputedAnalyses: z.number().int(),
  pending: z.number().int(),
  lastError: z.string().optional(),
});
export type MailboxSyncStatus = z.infer<typeof MailboxSyncStatusSchema>;

/* ------------------------------------------------------------------------- */
/*  8. Audit & supervision                                                   */
/* ------------------------------------------------------------------------- */

export const AuditEventTypeSchema = z.enum([
  "summary_generated",
  "thread_synthesis_generated",
  "draft_reply_generated",
  "search_executed",
  "chat_answered",
  "emails_indexed",
  "actions_proposed",
  "action_approved",
  "action_rejected",
  "action_executed",
  "action_failed",
  "compliance_check",
  "compliance_alert",
  "compliance_escalated",
  "compliance_decision",
  "phishing_check",
  "automation_proposed",
  "automation_simulated",
  "automation_approved",
  "automation_rejected",
  "automation_executed",
  "label_applied",
  "policy_updated",
  "error",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const ApprovalStatusSchema = z.enum(["auto_approved", "approved", "rejected", "escalated", "pending", "n/a"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  user: z.object({ id: z.string(), email: z.string(), displayName: z.string().optional() }),
  type: AuditEventTypeSchema,
  /** Source email / item label, e.g. "Re: Q2 Portfolio Update". */
  source: z.object({ label: z.string(), emailId: z.string().optional(), conversationId: z.string().optional(), counterpart: z.string().optional() }).optional(),
  riskLevel: RiskLevelSchema.optional(),
  approvalStatus: ApprovalStatusSchema.default("n/a"),
  approvedBy: z.string().optional(),
  confidence: ConfidenceSchema.optional(),
  model: z.string().optional(),
  latencyMs: z.number().optional(),
  /** Model input/output hashes + structured details (no raw email body stored by default). */
  details: z.record(z.string(), z.unknown()).default({}),
  correlationId: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const AuditQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  type: AuditEventTypeSchema.optional(),
  riskLevel: RiskLevelSchema.optional(),
  approvalStatus: ApprovalStatusSchema.optional(),
  search: z.string().optional(),
  /** Filter on `details.source` (llm | cache | precomputed | heuristic). */
  source: z.enum(["llm", "cache", "precomputed", "heuristic"]).optional(),
  /** Filter on the model name recorded on the event. */
  model: z.string().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(25),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditEventSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;

export const AuditStatsSchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  kpis: z.object({
    emailsSummarized: z.number().int(),
    draftsGenerated: z.number().int(),
    automationsProposed: z.number().int(),
    automationsApproved: z.number().int(),
    complianceAlerts: z.number().int(),
    errorsAvoided: z.number().int(),
    /** Percentage deltas vs the previous period of the same length. */
    deltas: z.record(z.string(), z.number()).default({}),
  }),
  activityOverTime: z.array(
    z.object({ date: z.string(), summaries: z.number().int(), drafts: z.number().int(), automations: z.number().int(), complianceAlerts: z.number().int() }),
  ),
  actionsByType: z.array(z.object({ type: z.string(), count: z.number().int(), share: z.number() })),
  complianceAlertsByCategory: z.array(z.object({ category: z.string(), count: z.number().int(), share: z.number() })),
  automationsApprovalRate: z.object({ current: z.number(), previous: z.number() }),
  topUsers: z.array(z.object({ userId: z.string(), displayName: z.string(), actions: z.number().int() })),
  totalActions: z.number().int(),
});
export type AuditStats = z.infer<typeof AuditStatsSchema>;

/* ------------------------------------------------------------------------- */
/*  9. Policies (admin)                                                      */
/* ------------------------------------------------------------------------- */

/** Row of `GET /admin/users` (admin role). */
export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().optional(),
  roles: z.array(z.enum(["user", "compliance", "admin"])).default(["user"]),
  /** Number of audited events for this user. */
  actions: z.number().int().nonnegative().default(0),
  lastActivityAt: z.string().optional(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const PolicySchema = z.object({
  /** Domains considered internal (e.g. ["northbridge.example"]). */
  internalDomains: z.array(z.string()),
  /** Attachment name / label patterns considered confidential. */
  confidentialPatterns: z.array(z.string()),
  /** Classification labels that are accepted. Empty = labels not enforced. */
  requiredClassificationLabels: z.array(z.string()),
  /** Regex patterns for sensitive client information (IBAN, account numbers, ...). */
  sensitiveDataPatterns: z.array(z.object({ name: z.string(), pattern: z.string(), severity: RiskLevelSchema })),
  /** Number of external recipients from which a "large distribution" warning fires. */
  largeDistributionThreshold: z.number().int().default(10),
  /** Actions that always require compliance approval. */
  complianceApprovalFor: z.array(ActionTypeSchema).default([]),
  /** Risk level from which human approval is mandatory (always at least "medium"). */
  approvalRequiredFrom: RiskLevelSchema.default("low"),
  /** Whether high-risk compliance issues block the send until approval. */
  blockOnHighRisk: z.boolean().default(false),
  updatedAt: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

/* ------------------------------------------------------------------------- */
/*  10. Misc                                                                 */
/* ------------------------------------------------------------------------- */

export const FeatureFlagsSchema = z.object({
  graphEnabled: z.boolean(),
  embeddingsEnabled: z.boolean(),
  llmProvider: z.string(),
  llmModel: z.string(),
  /** Smaller/faster model used for classification, triage, phishing, extraction (falls back to llmModel). */
  llmFastModel: z.string().optional(),
  embeddingModel: z.string().optional(),
  authMode: z.enum(["dev", "aad"]),
  /** Mailbox sync worker (precomputation) is running. */
  precomputeEnabled: z.boolean().default(false),
  dailyBriefEnabled: z.boolean().default(false),
  /** Display name of the organisation (env ORGANIZATION_NAME). */
  organizationName: z.string().optional(),
  version: z.string(),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

/** Admin: runtime status of the orchestrator (queues, caches, workers). */
export const SystemStatusSchema = z.object({
  health: z.lazy(() => HealthSchema),
  features: FeatureFlagsSchema,
  llmQueue: z.object({ pending: z.number().int(), running: z.number().int(), concurrency: z.number().int(), avgLatencyMs: z.number().optional(), circuitOpen: z.boolean() }),
  cache: z.object({ analysisHits: z.number().int(), analysisMisses: z.number().int(), embeddingHits: z.number().int(), embeddingMisses: z.number().int() }),
  sync: MailboxSyncStatusSchema.optional(),
  uptimeSeconds: z.number(),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const HealthSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  checks: z.record(z.string(), z.object({ status: z.enum(["ok", "degraded", "down"]), detail: z.string().optional() })),
  version: z.string(),
  timestamp: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    correlationId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const FeedbackRequestSchema = z.object({
  auditId: z.string(),
  rating: z.enum(["up", "down"]),
  comment: z.string().optional(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

/* ------------------------------------------------------------------------- */
/*  Route table (single source of truth for paths)                           */
/* ------------------------------------------------------------------------- */

export const API_PREFIX = "/api/v1";

export const Routes = {
  health: `${API_PREFIX}/health`,
  /** Liveness (process up) and readiness (dependencies reachable) for Kubernetes probes. */
  live: `${API_PREFIX}/live`,
  ready: `${API_PREFIX}/ready`,
  /** Prometheus metrics (no API prefix, protected by network policy / METRICS_TOKEN). */
  metrics: `/metrics`,
  features: `${API_PREFIX}/config/features`,
  me: `${API_PREFIX}/me`,

  analyzeEmail: `${API_PREFIX}/analyze/email`,
  /** Precomputed / cached analysis of a known email (404 when not available yet). */
  analysisByEmail: (emailId: string) => `${API_PREFIX}/analyze/email/${encodeURIComponent(emailId)}`,
  dailyBrief: `${API_PREFIX}/brief/daily`,
  mailboxSync: `${API_PREFIX}/mailbox/sync`,
  analyzeThread: `${API_PREFIX}/analyze/thread`,
  draftReply: `${API_PREFIX}/draft/reply`,

  search: `${API_PREFIX}/search`,
  chat: `${API_PREFIX}/chat`,
  chatSession: (id: string) => `${API_PREFIX}/chat/${id}`,
  indexEmails: `${API_PREFIX}/index/emails`,

  proposeActions: `${API_PREFIX}/actions/propose`,
  approveActions: `${API_PREFIX}/actions/approve`,
  reportActionResult: (id: string) => `${API_PREFIX}/actions/${id}/result`,

  complianceCheck: `${API_PREFIX}/compliance/check`,
  phishingCheck: `${API_PREFIX}/compliance/phishing`,
  escalations: `${API_PREFIX}/compliance/escalations`,
  escalation: (id: string) => `${API_PREFIX}/compliance/escalations/${id}`,
  escalationDecision: (id: string) => `${API_PREFIX}/compliance/escalations/${id}/decision`,

  automationsObserve: `${API_PREFIX}/automations/observe`,
  automations: `${API_PREFIX}/automations`,
  automation: (id: string) => `${API_PREFIX}/automations/${id}`,
  automationSimulate: (id: string) => `${API_PREFIX}/automations/${id}/simulate`,
  automationApprove: (id: string) => `${API_PREFIX}/automations/${id}/approve`,
  automationReject: (id: string) => `${API_PREFIX}/automations/${id}/reject`,
  automationDetect: `${API_PREFIX}/automations/detect`,

  audit: `${API_PREFIX}/audit`,
  auditStats: `${API_PREFIX}/audit/stats`,
  auditEvent: (id: string) => `${API_PREFIX}/audit/${id}`,
  auditExport: `${API_PREFIX}/audit/export`,
  feedback: `${API_PREFIX}/feedback`,

  adminPolicy: `${API_PREFIX}/admin/policy`,
  adminUsers: `${API_PREFIX}/admin/users`,
  adminSystem: `${API_PREFIX}/admin/system`,
} as const;

/* ------------------------------------------------------------------------- */
/*  Helpers                                                                  */
/* ------------------------------------------------------------------------- */

/** Extract the domain part of an email address (lower-cased). */
export function emailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : "";
}

/** True when `address` belongs to one of `internalDomains` (sub-domains included). */
export function isInternalAddress(address: string, internalDomains: string[]): boolean {
  const domain = emailDomain(address);
  if (!domain) return false;
  return internalDomains.some((d) => {
    const dd = d.toLowerCase();
    return domain === dd || domain.endsWith(`.${dd}`);
  });
}

/** Default policy used when the database has none yet. */
export const DEFAULT_POLICY: Policy = {
  /** Overridden by env INTERNAL_DOMAINS in production. */
  internalDomains: ["northbridge.example"],
  confidentialPatterns: ["confidential", "confidentiel", "internal only", "interne", "mandate", "mandat", "kyc", "performance report"],
  requiredClassificationLabels: ["Public", "Internal", "Confidential", "Highly Confidential"],
  sensitiveDataPatterns: [
    { name: "IBAN", pattern: "\\b[A-Z]{2}\\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}\\b", severity: "high" },
    { name: "Swiss AVS number", pattern: "\\b756\\.\\d{4}\\.\\d{4}\\.\\d{2}\\b", severity: "high" },
    { name: "Credit card", pattern: "\\b(?:\\d[ -]?){13,16}\\b", severity: "high" },
    { name: "Portfolio / account number", pattern: "\\b(?:account|compte|portfolio|portefeuille)\\s*(?:no\\.?|n°|number|#)?\\s*[:\\-]?\\s*[A-Z0-9\\-]{6,}\\b", severity: "medium" },
    { name: "Password", pattern: "(?i)\\b(?:password|mot de passe|mdp)\\s*[:=]", severity: "high" },
  ],
  largeDistributionThreshold: 10,
  complianceApprovalFor: ["escalate_compliance"],
  approvalRequiredFrom: "low",
  blockOnHighRisk: false,
};

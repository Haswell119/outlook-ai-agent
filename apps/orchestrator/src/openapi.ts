import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ActionProposalSchema,
  AnalyzeEmailRequestSchema,
  AnalyzeThreadRequestSchema,
  ApiErrorSchema,
  ApproveActionsRequestSchema,
  ApproveActionsResponseSchema,
  AuditPageSchema,
  AuditStatsSchema,
  AutomationListSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  ComplianceCheckRequestSchema,
  ComplianceCheckResponseSchema,
  DailyBriefRequestSchema,
  DailyBriefSchema,
  DraftReplyRequestSchema,
  DraftReplySchema,
  EmailAnalysisSchema,
  EscalationSchema,
  FeatureFlagsSchema,
  FeedbackRequestSchema,
  HealthSchema,
  IndexEmailsRequestSchema,
  IndexEmailsResponseSchema,
  MailboxSyncStatusSchema,
  PhishingCheckRequestSchema,
  PhishingCheckResponseSchema,
  PolicySchema,
  ProposeActionsRequestSchema,
  Routes,
  SearchRequestSchema,
  SearchResponseSchema,
  SystemStatusSchema,
  ThreadSynthesisSchema,
  UserIdentitySchema,
  API_PREFIX,
} from "@oao/shared";
import { APP_VERSION } from "./config.js";

/**
 * OpenAPI document, generated from the **shared zod contracts** so the spec can
 * never drift from what the code validates. Emitted to `openapi.json` at build
 * time (`src/scripts/openapi.ts`) and served at `/api/v1/docs` when
 * `API_DOCS_ENABLED=true`.
 *
 * `@fastify/swagger` runs in `static` mode with this document: route handlers
 * keep validating with zod (`parseBody`), so adding documentation changes no
 * runtime behaviour and no error shapes.
 */
/**
 * Convert every contract in one pass so that shared sub-schemas
 * (`SuggestedAction`, `DetectedRisk`, `EmailContext`…) become a single
 * `$ref` into `components/schemas` instead of being inlined dozens of times.
 */
function buildSchemaComponents(schemas: Record<string, ZodTypeAny>): Record<string, unknown> {
  // The library stores them under the literal `definitionPath` key and emits
  // `$ref: "#/components/schemas/<Name>"`, which is exactly where we mount them.
  const converted = zodToJsonSchema(z.object({}), { definitions: schemas, definitionPath: "components/schemas", target: "openApi3", $refStrategy: "root" }) as Record<string, unknown>;
  const out = converted["components/schemas"] as Record<string, unknown> | undefined;
  if (!out || Object.keys(out).length === 0) throw new Error("OpenAPI schema generation produced no components");
  return out;
}

const SCHEMAS: Record<string, ZodTypeAny> = {
  ApiError: ApiErrorSchema,
  Health: HealthSchema,
  FeatureFlags: FeatureFlagsSchema,
  SystemStatus: SystemStatusSchema,
  UserIdentity: UserIdentitySchema,
  AnalyzeEmailRequest: AnalyzeEmailRequestSchema,
  EmailAnalysis: EmailAnalysisSchema,
  AnalyzeThreadRequest: AnalyzeThreadRequestSchema,
  ThreadSynthesis: ThreadSynthesisSchema,
  DraftReplyRequest: DraftReplyRequestSchema,
  DraftReply: DraftReplySchema,
  DailyBriefRequest: DailyBriefRequestSchema,
  DailyBrief: DailyBriefSchema,
  MailboxSyncStatus: MailboxSyncStatusSchema,
  SearchRequest: SearchRequestSchema,
  SearchResponse: SearchResponseSchema,
  ChatRequest: ChatRequestSchema,
  ChatResponse: ChatResponseSchema,
  IndexEmailsRequest: IndexEmailsRequestSchema,
  IndexEmailsResponse: IndexEmailsResponseSchema,
  ProposeActionsRequest: ProposeActionsRequestSchema,
  ActionProposal: ActionProposalSchema,
  ApproveActionsRequest: ApproveActionsRequestSchema,
  ApproveActionsResponse: ApproveActionsResponseSchema,
  ComplianceCheckRequest: ComplianceCheckRequestSchema,
  ComplianceCheckResponse: ComplianceCheckResponseSchema,
  PhishingCheckRequest: PhishingCheckRequestSchema,
  PhishingCheckResponse: PhishingCheckResponseSchema,
  Escalation: EscalationSchema,
  AutomationList: AutomationListSchema,
  AuditPage: AuditPageSchema,
  AuditStats: AuditStatsSchema,
  Policy: PolicySchema,
  FeedbackRequest: FeedbackRequestSchema,
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const body = (name: string) => ({ required: true, content: { "application/json": { schema: ref(name) } } });
const ok = (name?: string, description = "Success") => ({ description, ...(name ? { content: { "application/json": { schema: ref(name) } } } : {}) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ref("ApiError") } } });

const COMMON_ERRORS = {
  400: err("Validation failed (`validation_error`)"),
  401: err("Missing or invalid credentials (`unauthorized`)"),
  403: err("Insufficient role (`forbidden`)"),
  429: err("Rate limited (`rate_limited`)"),
  500: err("Internal error (`internal_error`)"),
};

/** Strip the `/api/v1` prefix: it becomes the server base path. */
const p = (route: string) => route.replace(API_PREFIX, "") || "/";

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "Outlook AI Orchestrator — API",
      version: APP_VERSION,
      description: [
        "AI Orchestrator backend for the Outlook AI Orchestrator.",
        "",
        "**AI-load minimisation.** `EmailAnalysis.source` tells the caller how an answer was produced:",
        "`llm` (model called now), `cache` (identical content already analysed), `precomputed`",
        "(analysed ahead of time by the mailbox-sync worker) or `heuristic` (rules only — a triaged",
        "newsletter/notification, or the model was unavailable). `EmailAnalysis.triage.kind` says why.",
        "",
        "**Human-in-the-loop.** The AI never sends or deletes anything; every action goes through",
        "`/actions/propose` → human approval → `/actions/approve`.",
      ].join("\n"),
    },
    servers: [{ url: API_PREFIX, description: "API v1" }],
    tags: [
      { name: "system", description: "Probes, features, metrics" },
      { name: "analysis", description: "Email analysis, thread synthesis, drafts, daily brief" },
      { name: "search", description: "Retrieval and chat" },
      { name: "actions", description: "Human-in-the-loop actions" },
      { name: "compliance", description: "Compliance Guardian and escalations" },
      { name: "automations", description: "Automation Coach" },
      { name: "audit", description: "Audit trail and analytics" },
      { name: "admin", description: "Policy, users, runtime status" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Azure AD access token (`AUTH_MODE=aad`) or `ADMIN_API_TOKEN`." },
        devHeaders: { type: "apiKey", in: "header", name: "x-user-email", description: "Dev identity (`AUTH_MODE=dev` only, refused in production)." },
      },
      schemas: buildSchemaComponents(SCHEMAS),
      parameters: {
        AcceptLanguage: { name: "accept-language", in: "header", required: false, schema: { type: "string", example: "fr" }, description: "Response language (fr|en)." },
      },
    },
    security: [{ bearerAuth: [] }, { devHeaders: [] }],
    paths: {
      [p(Routes.live)]: {
        get: { tags: ["system"], operationId: "getLive", summary: "Liveness probe", security: [], responses: { 200: { description: "Process is up" } } },
      },
      [p(Routes.ready)]: {
        get: {
          tags: ["system"],
          operationId: "getReady",
          summary: "Readiness probe",
          description: "200 when the database is reachable and migrations are applied. An LLM or Graph outage does not make the service unready.",
          security: [],
          responses: { 200: { description: "Ready" }, 503: { description: "Not ready (database unreachable or migrations pending)" } },
        },
      },
      // Served outside the API prefix, so this path overrides the server base URL.
      "/metrics": {
        servers: [{ url: "/", description: "Root (no API prefix)" }],
        get: {
          tags: ["system"],
          operationId: "getMetrics",
          summary: "Prometheus metrics (served at `/metrics`, outside the API prefix)",
          description: "Requires `Authorization: Bearer <METRICS_TOKEN>` when `METRICS_TOKEN` is set.",
          responses: { 200: { description: "Prometheus exposition format", content: { "text/plain": { schema: { type: "string" } } } }, 401: err("Invalid metrics token") },
        },
      },
      [p(Routes.health)]: { get: { tags: ["system"], operationId: "getHealth", summary: "Detailed health", security: [], responses: { 200: ok("Health") } } },
      [p(Routes.features)]: { get: { tags: ["system"], operationId: "getFeatures", summary: "Feature flags", security: [], responses: { 200: ok("FeatureFlags") } } },
      [p(Routes.me)]: { get: { tags: ["system"], operationId: "getMe", summary: "Caller identity", responses: { 200: ok("UserIdentity"), ...COMMON_ERRORS } } },

      [p(Routes.analyzeEmail)]: {
        post: {
          tags: ["analysis"],
          operationId: "analyzeEmail",
          summary: "Analyse one email",
          description: "Triage runs first: non-conversation emails are answered from heuristics with `source: \"heuristic\"` and no model call. Identical content already analysed returns `source: \"cache\"`.",
          parameters: [{ $ref: "#/components/parameters/AcceptLanguage" }],
          requestBody: body("AnalyzeEmailRequest"),
          responses: { 200: ok("EmailAnalysis"), ...COMMON_ERRORS, 502: err("The model is unavailable and no heuristic answer was possible (`llm_unavailable`)") },
        },
      },
      [`${p(Routes.analyzeEmail)}/{emailId}`]: {
        get: {
          tags: ["analysis"],
          operationId: "getAnalysisByEmail",
          summary: "Precomputed / cached analysis of a known email",
          description: "Never calls the model. Returns `source: \"precomputed\"` or `\"cache\"`. **404 means \"not computed yet\"** — the caller should POST `/analyze/email` with the content it already has.",
          parameters: [{ name: "emailId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: ok("EmailAnalysis"), 404: err("No analysis available for this email yet"), ...COMMON_ERRORS },
        },
      },
      [p(Routes.analyzeThread)]: {
        post: { tags: ["analysis"], operationId: "analyzeThread", summary: "Synthesise a conversation", requestBody: body("AnalyzeThreadRequest"), responses: { 200: ok("ThreadSynthesis"), ...COMMON_ERRORS } },
      },
      [p(Routes.draftReply)]: {
        post: { tags: ["analysis"], operationId: "draftReply", summary: "Generate a reply draft (never sent)", requestBody: body("DraftReplyRequest"), responses: { 200: ok("DraftReply"), ...COMMON_ERRORS } },
      },
      [p(Routes.dailyBrief)]: {
        get: {
          tags: ["analysis"],
          operationId: "getDailyBrief",
          summary: "Stored daily brief",
          parameters: [{ name: "date", in: "query", required: false, schema: { type: "string", example: "2026-09-15" }, description: "ISO date in the user's timezone (default: today)." }],
          responses: { 200: ok("DailyBrief"), 404: err("No brief generated for that date"), ...COMMON_ERRORS },
        },
        post: { tags: ["analysis"], operationId: "generateDailyBrief", summary: "Generate the daily brief on demand", requestBody: body("DailyBriefRequest"), responses: { 200: ok("DailyBrief"), ...COMMON_ERRORS } },
      },
      [p(Routes.mailboxSync)]: {
        get: {
          tags: ["analysis"],
          operationId: "getMailboxSync",
          summary: "Precomputation status",
          parameters: [{ name: "userId", in: "query", required: false, schema: { type: "string" }, description: "Admin only: another user's status." }],
          responses: { 200: ok("MailboxSyncStatus"), ...COMMON_ERRORS },
        },
        post: {
          tags: ["analysis"],
          operationId: "triggerMailboxSync",
          summary: "Trigger a sync now",
          parameters: [{ name: "userId", in: "query", required: false, schema: { type: "string" }, description: "Admin only: sync another user." }],
          responses: { 202: ok("MailboxSyncStatus", "Sync executed; the body also carries a `result` summary"), 409: err("A sync is already running"), 503: err("Precomputation is disabled (`graph_unavailable`)"), ...COMMON_ERRORS },
        },
      },

      [p(Routes.search)]: {
        post: { tags: ["search"], operationId: "search", summary: "Hybrid retrieval", requestBody: body("SearchRequest"), responses: { 200: ok("SearchResponse"), ...COMMON_ERRORS } },
        get: { tags: ["search"], operationId: "searchGet", summary: "Hybrid retrieval (query string)", parameters: [{ name: "query", in: "query", required: true, schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { 200: ok("SearchResponse"), ...COMMON_ERRORS } },
      },
      [p(Routes.chat)]: { post: { tags: ["search"], operationId: "chat", summary: "Answer a question over the mailbox", requestBody: body("ChatRequest"), responses: { 200: ok("ChatResponse"), ...COMMON_ERRORS } } },
      [p(Routes.indexEmails)]: { post: { tags: ["search"], operationId: "indexEmails", summary: "Index emails for retrieval", requestBody: body("IndexEmailsRequest"), responses: { 200: ok("IndexEmailsResponse"), ...COMMON_ERRORS } } },

      [p(Routes.proposeActions)]: { post: { tags: ["actions"], operationId: "proposeActions", summary: "Propose actions (human validation required)", requestBody: body("ProposeActionsRequest"), responses: { 200: ok("ActionProposal"), ...COMMON_ERRORS } } },
      [p(Routes.approveActions)]: {
        post: {
          tags: ["actions"],
          operationId: "approveActions",
          summary: "Approve and execute selected actions",
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" }, description: "Retry-safe key kept for `IDEMPOTENCY_TTL_HOURS` (default 24 h). Replaying it with a different body returns 409." }],
          requestBody: body("ApproveActionsRequest"),
          responses: { 200: ok("ApproveActionsResponse"), 409: err("Proposal expired, or Idempotency-Key reused with a different body"), ...COMMON_ERRORS },
        },
      },

      [p(Routes.complianceCheck)]: { post: { tags: ["compliance"], operationId: "complianceCheck", summary: "Pre-send compliance check", requestBody: body("ComplianceCheckRequest"), responses: { 200: ok("ComplianceCheckResponse"), ...COMMON_ERRORS } } },
      [p(Routes.phishingCheck)]: { post: { tags: ["compliance"], operationId: "phishingCheck", summary: "Inbound phishing screening (heuristic, no model call)", requestBody: body("PhishingCheckRequest"), responses: { 200: ok("PhishingCheckResponse"), ...COMMON_ERRORS } } },
      [p(Routes.escalations)]: {
        get: { tags: ["compliance"], operationId: "listEscalations", summary: "List compliance escalations", responses: { 200: { description: "Escalations", content: { "application/json": { schema: { type: "array", items: ref("Escalation") } } } }, ...COMMON_ERRORS } },
        post: { tags: ["compliance"], operationId: "createEscalation", summary: "Escalate to compliance", responses: { 201: ok("Escalation"), ...COMMON_ERRORS } },
      },

      [p(Routes.automations)]: { get: { tags: ["automations"], operationId: "listAutomations", summary: "List detected automations", responses: { 200: ok("AutomationList"), ...COMMON_ERRORS } } },

      [p(Routes.audit)]: { get: { tags: ["audit"], operationId: "queryAudit", summary: "Query the audit trail", responses: { 200: ok("AuditPage"), ...COMMON_ERRORS } } },
      [p(Routes.auditStats)]: { get: { tags: ["audit"], operationId: "auditStats", summary: "Audit KPIs", responses: { 200: ok("AuditStats"), ...COMMON_ERRORS } } },
      [p(Routes.auditExport)]: {
        get: {
          tags: ["audit"],
          operationId: "auditExport",
          summary: "Stream the audit trail as CSV",
          description: "Streamed with keyset pagination, so a multi-year export never buffers in memory.",
          responses: { 200: { description: "CSV stream", content: { "text/csv": { schema: { type: "string" } } } }, ...COMMON_ERRORS },
        },
      },
      [p(Routes.feedback)]: { post: { tags: ["audit"], operationId: "submitFeedback", summary: "Thumbs up/down on an AI answer", requestBody: body("FeedbackRequest"), responses: { 201: { description: "Recorded" }, ...COMMON_ERRORS } } },

      [p(Routes.adminPolicy)]: {
        get: { tags: ["admin"], operationId: "getPolicy", summary: "Current policy", responses: { 200: ok("Policy"), ...COMMON_ERRORS } },
        put: { tags: ["admin"], operationId: "putPolicy", summary: "Replace the policy", requestBody: body("Policy"), responses: { 200: ok("Policy"), ...COMMON_ERRORS } },
      },
      [p(Routes.adminSystem)]: {
        get: {
          tags: ["admin"],
          operationId: "getSystemStatus",
          summary: "Runtime status (queue, circuit, caches, sync)",
          parameters: [{ name: "userId", in: "query", required: false, schema: { type: "string" }, description: "Mailbox whose sync status is included." }],
          responses: { 200: ok("SystemStatus"), ...COMMON_ERRORS },
        },
      },
    },
  };
}

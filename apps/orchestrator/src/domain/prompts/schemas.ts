import { z } from "zod";
import { ActionTypeSchema, LanguageSchema, RiskLevelSchema } from "@oao/shared";

/**
 * Raw JSON schemas expected from the model. They are deliberately lenient
 * (defaults, catch) so that a slightly sloppy model answer still validates;
 * the services enrich them into the public contracts.
 */
const str = z.string().catch("");
const strArr = z.array(z.string().catch("")).catch([]).transform((a) => a.filter((s) => s.trim().length > 0));
const conf = z.coerce.number().min(0).max(1).catch(0.6);
const risk = RiskLevelSchema.catch("medium");

export const LlmRiskSchema = z.object({
  code: z.string().catch("risk"),
  title: str,
  description: z.string().optional().catch(undefined),
  severity: risk,
});

/** Suggested actions: unknown types are dropped instead of failing the whole answer. */
export const LlmSuggestedActionSchema = z.object({
  type: ActionTypeSchema,
  title: str,
  description: str,
  parameters: z.record(z.string(), z.unknown()).catch({}),
});
const actionList = z
  .array(z.unknown())
  .catch([])
  .transform((items) => items.map((i) => LlmSuggestedActionSchema.safeParse(i)).filter((r) => r.success).map((r) => r.data));

/**
 * Action types that file / classify an email. In the narrative path the
 * decision engine owns filing (deterministic `move_to_folder` suggestion), so
 * these are dropped from the model's answer even if it produces them.
 */
export const FILING_ACTION_TYPES: ReadonlySet<string> = new Set(["categorize", "classify_email", "move_to_folder", "archive"]);

export const EmailAnalysisLlmSchema = z.object({
  language: LanguageSchema.catch("en"),
  summary: z.string().min(1),
  decisions: strArr,
  pendingTasks: strArr,
  risks: z.array(LlmRiskSchema).catch([]),
  suggestedActions: actionList,
  quickReplies: strArr.transform((a) => a.slice(0, 4)),
  classification: z.object({ category: str, confidence: conf }).optional().catch(undefined),
  confidence: conf,
});
export type EmailAnalysisLlm = z.infer<typeof EmailAnalysisLlmSchema>;

/**
 * Reduced (narrative) analysis: only what needs free-text understanding.
 * Deliberately **no** classification, folder, urgency or reply-expected field:
 * those come from the decision engine, and the model is never asked for a
 * value that would then be ignored.
 */
export const EmailNarrativeLlmSchema = z.object({
  language: LanguageSchema.catch("en"),
  summary: z.string().min(1),
  decisions: strArr,
  pendingTasks: strArr,
  /** Narrative risks: the ones that need reading the text (missing documents, contradictions, confidentiality…). */
  risks: z.array(LlmRiskSchema).catch([]),
  suggestedActions: actionList.transform((actions) => actions.filter((a) => !FILING_ACTION_TYPES.has(a.type))),
  quickReplies: strArr.transform((a) => a.slice(0, 4)),
  /** Confidence of the generated content. */
  confidence: conf,
});
export type EmailNarrativeLlm = z.infer<typeof EmailNarrativeLlmSchema>;

export const ThreadSynthesisLlmSchema = z.object({
  language: LanguageSchema.catch("en"),
  executiveSummary: z.string().min(1),
  missingDocuments: z.array(z.object({ name: str, requestedOn: z.string().optional().catch(undefined), requestedFrom: z.string().optional().catch(undefined) })).catch([]),
  decisions: strArr,
  openTasks: z
    .array(
      z.object({
        title: str,
        owner: z.string().optional().catch(undefined),
        priority: z.enum(["low", "medium", "high"]).catch("medium"),
        dueDate: z.string().optional().catch(undefined),
        done: z.boolean().catch(false),
        critical: z.boolean().catch(false),
      }),
    )
    .catch([]),
  deadlines: z.array(z.object({ title: str, date: z.string().optional().catch(undefined), description: z.string().optional().catch(undefined), atRisk: z.boolean().catch(false) })).catch([]),
  risks: z.array(LlmRiskSchema).catch([]),
  recommendedActions: actionList,
  recommendedNextStep: z.object({ title: str, description: str, action: LlmSuggestedActionSchema.optional().catch(undefined) }).optional().catch(undefined),
  confidence: conf,
});
export type ThreadSynthesisLlm = z.infer<typeof ThreadSynthesisLlmSchema>;

export const DraftReplyLlmSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  language: LanguageSchema.catch("en"),
  confidence: conf,
});
export type DraftReplyLlm = z.infer<typeof DraftReplyLlmSchema>;

export const ChatAnswerLlmSchema = z.object({
  headline: z.string().optional().catch(undefined),
  answer: z.string().min(1),
  /** 1-based ids of the sources used ([1]..[n]). */
  sourceIds: z.array(z.coerce.number().int()).catch([]),
  evidenceSourceId: z.coerce.number().int().optional().catch(undefined),
  quote: z.string().optional().catch(undefined),
  confidence: conf,
});
export type ChatAnswerLlm = z.infer<typeof ChatAnswerLlmSchema>;

export const ClassificationLlmSchema = z.object({
  category: z.string().min(1),
  confidence: conf,
  reasons: strArr,
});
export type ClassificationLlm = z.infer<typeof ClassificationLlmSchema>;

export const ComplianceContentLlmSchema = z.object({
  sensitive: z.boolean(),
  explanation: str,
  categories: strArr,
  confidence: conf,
});
export type ComplianceContentLlm = z.infer<typeof ComplianceContentLlmSchema>;

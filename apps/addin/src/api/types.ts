import type {
  ActionProposal,
  ApproveActionsRequest,
  ApproveActionsResponse,
  Automation,
  ChatRequest,
  ChatResponse,
  ComplianceCheckRequest,
  ComplianceCheckResponse,
  DraftReply,
  DraftReplyRequest,
  EmailAnalysis,
  Escalation,
  FeedbackRequest,
  Health,
  IndexEmailsRequest,
  IndexEmailsResponse,
  ProposeActionsRequest,
  ReportActionResultRequest,
  ThreadSynthesis,
  UserActionEvent,
  AnalyzeEmailRequest,
  AnalyzeThreadRequest,
} from "@oao/shared";
import type { z } from "zod";
import { EscalationRequestSchema, SimulateAutomationRequestSchema, AutomationDecisionRequestSchema } from "@oao/shared";

export type EscalationRequest = z.input<typeof EscalationRequestSchema>;
export type SimulateAutomationRequest = z.input<typeof SimulateAutomationRequestSchema>;
export type AutomationDecisionRequest = z.input<typeof AutomationDecisionRequestSchema>;

/** The orchestrator API as used by the add-in (one method per route we call). */
export interface OaoApi {
  readonly mode: "live" | "mock";
  health(): Promise<Health>;
  analyzeEmail(req: AnalyzeEmailRequest): Promise<EmailAnalysis>;
  analyzeThread(req: AnalyzeThreadRequest): Promise<ThreadSynthesis>;
  draftReply(req: DraftReplyRequest): Promise<DraftReply>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  indexEmails(req: IndexEmailsRequest): Promise<IndexEmailsResponse>;
  proposeActions(req: ProposeActionsRequest): Promise<ActionProposal>;
  approveActions(req: ApproveActionsRequest): Promise<ApproveActionsResponse>;
  reportActionResult(actionId: string, req: ReportActionResultRequest): Promise<void>;
  complianceCheck(req: ComplianceCheckRequest): Promise<ComplianceCheckResponse>;
  createEscalation(req: EscalationRequest): Promise<Escalation>;
  observe(event: UserActionEvent): Promise<void>;
  listAutomations(): Promise<Automation[]>;
  detectAutomations(): Promise<Automation[]>;
  simulateAutomation(id: string, req: SimulateAutomationRequest): Promise<Automation>;
  approveAutomation(id: string, req: AutomationDecisionRequest): Promise<Automation>;
  rejectAutomation(id: string, req: AutomationDecisionRequest): Promise<Automation>;
  feedback(req: FeedbackRequest): Promise<void>;
}

import { ActionsService } from "./ActionsService.js";
import { AnalyzeEmailService } from "./AnalyzeEmailService.js";
import { AuditService } from "./AuditService.js";
import { AutomationCoachService } from "./AutomationCoachService.js";
import { ChatService } from "./ChatService.js";
import { ComplianceService } from "./ComplianceService.js";
import type { ServiceDeps } from "./context.js";
import { DraftReplyService } from "./DraftReplyService.js";
import { EscalationService } from "./EscalationService.js";
import { FeedbackService } from "./FeedbackService.js";
import { IndexEmailsService } from "./IndexEmailsService.js";
import { PolicyService } from "./PolicyService.js";
import { SearchService } from "./SearchService.js";
import { SynthesizeThreadService } from "./SynthesizeThreadService.js";
import { UsersService } from "./UsersService.js";

export interface Services {
  audit: AuditService;
  policy: PolicyService;
  analyzeEmail: AnalyzeEmailService;
  synthesizeThread: SynthesizeThreadService;
  draftReply: DraftReplyService;
  indexEmails: IndexEmailsService;
  search: SearchService;
  chat: ChatService;
  escalations: EscalationService;
  actions: ActionsService;
  compliance: ComplianceService;
  automations: AutomationCoachService;
  feedback: FeedbackService;
  users: UsersService;
}

/** Wire every use case once (composition root helper). */
export function createServices(deps: ServiceDeps): Services {
  const audit = new AuditService(deps.repos.audit, deps.cfg.AUDIT_STORE_CONTENT, deps.logger);
  const policy = new PolicyService(deps.repos.policy, audit);
  const analyzeEmail = new AnalyzeEmailService(deps, audit, policy);
  const synthesizeThread = new SynthesizeThreadService(deps, audit);
  const draftReply = new DraftReplyService(deps, audit);
  const indexEmails = new IndexEmailsService(deps, audit);
  const search = new SearchService(deps, audit, indexEmails);
  const chat = new ChatService(deps, audit, search);
  const escalations = new EscalationService(deps, audit);
  const actions = new ActionsService(deps, audit, policy, analyzeEmail, synthesizeThread, escalations);
  const compliance = new ComplianceService(deps, audit, policy);
  const automations = new AutomationCoachService(deps, audit);
  const feedback = new FeedbackService(deps, audit);
  const users = new UsersService(audit, deps.cfg);
  return { audit, policy, analyzeEmail, synthesizeThread, draftReply, indexEmails, search, chat, escalations, actions, compliance, automations, feedback, users };
}

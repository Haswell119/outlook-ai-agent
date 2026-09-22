import { ActionsService } from "./ActionsService.js";
import { AiCacheService } from "./AiCacheService.js";
import { AnalyzeEmailService } from "./AnalyzeEmailService.js";
import { AuditService } from "./AuditService.js";
import { AutomationCoachService } from "./AutomationCoachService.js";
import { ChatService } from "./ChatService.js";
import { ComplianceService } from "./ComplianceService.js";
import type { ServiceDeps } from "./context.js";
import { DailyBriefService } from "./DailyBriefService.js";
import { DraftReplyService } from "./DraftReplyService.js";
import { EscalationService } from "./EscalationService.js";
import { FeedbackService } from "./FeedbackService.js";
import { IndexEmailsService } from "./IndexEmailsService.js";
import { PolicyService } from "./PolicyService.js";
import { SearchService } from "./SearchService.js";
import { SynthesizeThreadService } from "./SynthesizeThreadService.js";
import { UsersService } from "./UsersService.js";
import type { Metrics } from "../metrics.js";
import { MailboxSyncService } from "../workers/mailboxSync.js";

export interface Services {
  audit: AuditService;
  policy: PolicyService;
  cache: AiCacheService;
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
  dailyBrief: DailyBriefService;
  mailboxSync: MailboxSyncService;
}

/** Wire every use case once (composition root helper). */
export function createServices(deps: ServiceDeps, metrics?: Metrics): Services {
  const audit = new AuditService(deps.repos.audit, deps.cfg.AUDIT_STORE_CONTENT, deps.logger, metrics);
  const policy = new PolicyService(deps.repos.policy, audit, deps.cfg.INTERNAL_DOMAINS);
  const cache = new AiCacheService(deps.repos.analysisCache, { enabled: deps.cfg.ANALYSIS_CACHE_ENABLED, ttlHours: deps.cfg.ANALYSIS_CACHE_TTL_HOURS, logger: deps.logger, metrics });
  const indexEmails = new IndexEmailsService(deps, audit);
  const analyzeEmail = new AnalyzeEmailService(deps, audit, policy, cache, metrics, indexEmails);
  const synthesizeThread = new SynthesizeThreadService(deps, audit, cache);
  const draftReply = new DraftReplyService(deps, audit, cache);
  const search = new SearchService(deps, audit, indexEmails);
  const chat = new ChatService(deps, audit, search);
  const escalations = new EscalationService(deps, audit);
  const actions = new ActionsService(deps, audit, policy, analyzeEmail, synthesizeThread, escalations);
  const compliance = new ComplianceService(deps, audit, policy);
  const automations = new AutomationCoachService(deps, audit);
  const feedback = new FeedbackService(deps, audit);
  const users = new UsersService(audit, deps.cfg);
  const dailyBrief = new DailyBriefService(deps, audit, cache, metrics);
  const mailboxSync = new MailboxSyncService(deps, audit, indexEmails, analyzeEmail, policy, metrics);
  return { audit, policy, cache, analyzeEmail, synthesizeThread, draftReply, indexEmails, search, chat, escalations, actions, compliance, automations, feedback, users, dailyBrief, mailboxSync };
}

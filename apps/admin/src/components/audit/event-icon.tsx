import * as React from "react";
import {
  AlertTriangle,
  Ban,
  Bot,
  CheckCircle2,
  CircleAlert,
  Database,
  FileText,
  Fish,
  Layers,
  MessageSquare,
  PenLine,
  PlayCircle,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tags,
  Wand2,
  XCircle,
} from "lucide-react";
import type { AuditEventType } from "@oao/shared";

type IconComp = React.ComponentType<{ className?: string }>;

const MAP: Record<AuditEventType, { icon: IconComp; label: string; tone: string }> = {
  summary_generated: { icon: FileText, label: "Summary generated", tone: "text-brand" },
  thread_synthesis_generated: { icon: Layers, label: "Thread synthesis", tone: "text-brand" },
  draft_reply_generated: { icon: PenLine, label: "Draft reply generated", tone: "text-[#2E9E6B]" },
  search_executed: { icon: Search, label: "Search executed", tone: "text-[#616161]" },
  chat_answered: { icon: MessageSquare, label: "Chat answered", tone: "text-brand" },
  emails_indexed: { icon: Database, label: "Emails indexed", tone: "text-[#616161]" },
  actions_proposed: { icon: Sparkles, label: "Actions proposed", tone: "text-[#8A6BD9]" },
  action_approved: { icon: CheckCircle2, label: "Action approved", tone: "text-[#107C10]" },
  action_rejected: { icon: XCircle, label: "Action rejected", tone: "text-[#C4314B]" },
  action_executed: { icon: PlayCircle, label: "Action executed", tone: "text-[#107C10]" },
  action_failed: { icon: CircleAlert, label: "Action failed", tone: "text-[#C4314B]" },
  compliance_check: { icon: ShieldCheck, label: "Compliance check", tone: "text-brand" },
  compliance_alert: { icon: ShieldAlert, label: "Compliance alert", tone: "text-[#C4314B]" },
  compliance_escalated: { icon: AlertTriangle, label: "Escalated to compliance", tone: "text-[#8A6D00]" },
  compliance_decision: { icon: CheckCircle2, label: "Compliance decision", tone: "text-[#107C10]" },
  phishing_check: { icon: Fish, label: "Phishing check", tone: "text-[#8A6D00]" },
  automation_proposed: { icon: Wand2, label: "Automation proposed", tone: "text-[#8A6BD9]" },
  automation_simulated: { icon: Bot, label: "Automation simulated", tone: "text-[#8A6BD9]" },
  automation_approved: { icon: CheckCircle2, label: "Automation approved", tone: "text-[#107C10]" },
  automation_rejected: { icon: Ban, label: "Automation rejected", tone: "text-[#C4314B]" },
  automation_executed: { icon: PlayCircle, label: "Automation executed", tone: "text-[#107C10]" },
  label_applied: { icon: Tags, label: "Label applied", tone: "text-brand" },
  policy_updated: { icon: Settings2, label: "Policy updated", tone: "text-[#8A6D00]" },
  error: { icon: CircleAlert, label: "Error", tone: "text-[#C4314B]" },
};

export function eventMeta(type: AuditEventType) {
  return MAP[type] ?? { icon: FileText, label: type, tone: "text-[#616161]" };
}

export const AUDIT_EVENT_TYPES = Object.keys(MAP) as AuditEventType[];

export function EventIcon({ type, className }: { type: AuditEventType; className?: string }) {
  const { icon: Icon, tone } = eventMeta(type);
  return <Icon className={className ? className : `h-4 w-4 shrink-0 ${tone}`} />;
}

export function EventTypeCell({ type }: { type: AuditEventType }) {
  const meta = eventMeta(type);
  const Icon = meta.icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className={`h-4 w-4 shrink-0 ${meta.tone}`} />
      <span className="truncate font-medium">{meta.label}</span>
    </span>
  );
}

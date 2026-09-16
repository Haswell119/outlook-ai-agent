import { AlertTriangle, CheckCircle2, CircleDashed, Minus, ShieldCheck, XCircle } from "lucide-react";
import type { ApprovalStatus } from "@oao/shared";

const ICONS: Record<ApprovalStatus, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  approved: { icon: CheckCircle2, tone: "text-[#107C10]" },
  auto_approved: { icon: ShieldCheck, tone: "text-[#0F6CBD]" },
  rejected: { icon: XCircle, tone: "text-[#C4314B]" },
  escalated: { icon: AlertTriangle, tone: "text-[#8A6D00]" },
  pending: { icon: CircleDashed, tone: "text-[#8A8886]" },
  "n/a": { icon: Minus, tone: "text-[#A19F9D]" },
};

export function ApprovalCell({
  status,
  approvedBy,
  policy,
  messages,
}: {
  status: ApprovalStatus;
  approvedBy?: string;
  policy?: string;
  messages: Record<string, string>;
}) {
  const { icon: Icon, tone } = ICONS[status] ?? ICONS["n/a"];
  const label = messages[`approval.${status}`] ?? status;
  const by = approvedBy ? `${messages["approval.by"] ?? "by"} ${approvedBy}` : policy ? `Policy: ${policy}` : undefined;
  return (
    <span className="flex max-w-full items-start gap-1.5">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <span className="min-w-0">
        <span className="block truncate font-medium text-[#242424]">{label}</span>
        {by && <span className="block truncate text-xs text-[#616161]">{by}</span>}
      </span>
    </span>
  );
}

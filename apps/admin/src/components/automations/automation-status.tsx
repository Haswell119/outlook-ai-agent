import type { AutomationStatus } from "@oao/shared";
import { Badge, type BadgeProps } from "@/components/ui/badge";

const VARIANTS: Record<AutomationStatus, NonNullable<BadgeProps["variant"]>> = {
  proposed: "info",
  simulated: "medium",
  approved: "low",
  active: "low",
  rejected: "high",
  paused: "neutral",
};

const LABELS: Record<AutomationStatus, string> = {
  proposed: "Proposed",
  simulated: "Simulated",
  approved: "Approved",
  active: "Active",
  rejected: "Rejected",
  paused: "Paused",
};

export function AutomationStatusBadge({ status }: { status: AutomationStatus }) {
  return <Badge variant={VARIANTS[status]}>{LABELS[status]}</Badge>;
}

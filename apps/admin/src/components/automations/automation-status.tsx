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

export function AutomationStatusBadge({
  status,
  messages,
}: {
  status: AutomationStatus;
  messages?: Record<string, string>;
}) {
  const label = messages?.[`automationStatus.${status}`] ?? status;
  return <Badge variant={VARIANTS[status]}>{label}</Badge>;
}

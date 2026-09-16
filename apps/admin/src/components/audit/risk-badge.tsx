import type { RiskLevel } from "@oao/shared";
import { Badge } from "@/components/ui/badge";

export function RiskBadge({
  level,
  messages,
}: {
  level?: RiskLevel;
  messages?: Record<string, string>;
}) {
  if (!level) return <span className="text-[#A19F9D]">—</span>;
  const label = messages?.[`risk.${level}`] ?? level;
  return <Badge variant={level}>{label}</Badge>;
}

import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { deltaTone, formatDelta, formatNumber } from "@/lib/format";
import type { Language } from "@oao/shared";

export interface KpiTileProps {
  label: string;
  value: number;
  delta?: number;
  /** When true a rising value is a warning (compliance alerts), so the arrow is red. */
  invertDelta?: boolean;
  icon: React.ReactNode;
  iconTone?: "brand" | "success" | "warning" | "danger" | "purple";
  vsLabel: string;
  language: Language;
}

const TONES: Record<NonNullable<KpiTileProps["iconTone"]>, string> = {
  brand: "bg-[#E8F1FB] text-[#0F6CBD]",
  success: "bg-[#DFF6DD] text-[#107C10]",
  warning: "bg-[#FFF4CE] text-[#8A6D00]",
  danger: "bg-[#FDE7E9] text-[#C4314B]",
  purple: "bg-[#F0EAFB] text-[#6B44C9]",
};

export function KpiTile({
  label,
  value,
  delta,
  invertDelta = false,
  icon,
  iconTone = "brand",
  vsLabel,
  language,
}: KpiTileProps) {
  const tone = deltaTone(delta, invertDelta);
  const Arrow = delta === undefined || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <Card className="p-4" data-testid="kpi-tile">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#616161]">{label}</p>
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", TONES[iconTone])}>
          {icon}
        </span>
      </div>
      <p
        className="mt-2 text-2xl font-semibold leading-none text-[#242424]"
        data-testid="kpi-value"
      >
        {formatNumber(value, language)}
      </p>
      <p
        className={cn(
          "mt-2 flex items-center gap-1 text-xs font-medium",
          tone === "positive" && "text-[#107C10]",
          tone === "negative" && "text-[#C4314B]",
          tone === "neutral" && "text-[#616161]",
        )}
      >
        <Arrow className="h-3.5 w-3.5" aria-hidden="true" />
        {formatDelta(delta)}
        <span className="font-normal text-[#616161]">{vsLabel}</span>
      </p>
    </Card>
  );
}

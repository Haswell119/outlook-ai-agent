import { AlertTriangle, CheckCircle2, FileText, PenLine, ShieldCheck, Wand2 } from "lucide-react";
import type { AuditStats, Language } from "@oao/shared";
import { KpiTile, type KpiTileProps } from "./kpi-tile";

export function KpiRow({
  stats,
  messages,
  language,
}: {
  stats: AuditStats;
  messages: Record<string, string>;
  language: Language;
}) {
  const t = (k: string) => messages[k] ?? k;
  const { kpis } = stats;
  const d = kpis.deltas;

  const tiles: Array<Omit<KpiTileProps, "vsLabel" | "language">> = [
    {
      label: t("kpi.emailsSummarized"),
      value: kpis.emailsSummarized,
      delta: d.emailsSummarized,
      icon: <FileText className="h-4 w-4" />,
      iconTone: "brand",
    },
    {
      label: t("kpi.draftsGenerated"),
      value: kpis.draftsGenerated,
      delta: d.draftsGenerated,
      icon: <PenLine className="h-4 w-4" />,
      iconTone: "success",
    },
    {
      label: t("kpi.automationsProposed"),
      value: kpis.automationsProposed,
      delta: d.automationsProposed,
      icon: <Wand2 className="h-4 w-4" />,
      iconTone: "purple",
    },
    {
      label: t("kpi.automationsApproved"),
      value: kpis.automationsApproved,
      delta: d.automationsApproved,
      icon: <CheckCircle2 className="h-4 w-4" />,
      iconTone: "success",
    },
    {
      // More compliance alerts than last week is a warning: the arrow stays red.
      label: t("kpi.complianceAlerts"),
      value: kpis.complianceAlerts,
      delta: d.complianceAlerts,
      invertDelta: true,
      icon: <AlertTriangle className="h-4 w-4" />,
      iconTone: "danger",
    },
    {
      label: t("kpi.errorsAvoided"),
      value: kpis.errorsAvoided,
      delta: d.errorsAvoided,
      icon: <ShieldCheck className="h-4 w-4" />,
      iconTone: "brand",
    },
  ];

  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {tiles.map((tile) => (
        <KpiTile key={tile.label} {...tile} vsLabel={t("kpi.vsPrevious")} language={language} />
      ))}
    </div>
  );
}

"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AuditStats, Language } from "@oao/shared";
import { AXIS, GRID, SERIES } from "./palette";
import { formatDateShort } from "@/lib/format";

export function ActivityChart({
  data,
  language,
  labels,
}: {
  data: AuditStats["activityOverTime"];
  language: Language;
  labels: { summaries: string; drafts: string; automations: string; complianceAlerts: string };
}) {
  const rows = data.map((d) => ({ ...d, label: formatDateShort(`${d.date}T00:00:00Z`, language) }));
  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={{ fill: AXIS, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} />
          <YAxis tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: "1px solid #E1DFDD",
              fontSize: 12,
              boxShadow: "0 4px 12px rgba(0,0,0,.08)",
            }}
          />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
          <Line type="monotone" dataKey="summaries" name={labels.summaries} stroke={SERIES.summaries} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="drafts" name={labels.drafts} stroke={SERIES.drafts} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="automations" name={labels.automations} stroke={SERIES.automations} strokeWidth={2} dot={false} />
          <Line
            type="monotone"
            dataKey="complianceAlerts"
            name={labels.complianceAlerts}
            stroke={SERIES.complianceAlerts}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatNumber, formatPercent } from "@/lib/format";
import type { Language } from "@oao/shared";

export interface DonutDatum {
  name: string;
  value: number;
  share: number;
}

export function DonutChart({
  data,
  colors,
  centerValue,
  centerLabel,
  language,
}: {
  data: DonutDatum[];
  colors: string[];
  centerValue: number;
  centerLabel: string;
  language: Language;
}) {
  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row">
      <div className="relative h-[168px] w-[168px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={54}
              outerRadius={78}
              paddingAngle={1.5}
              stroke="#fff"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((d, i) => (
                <Cell key={d.name} fill={colors[i % colors.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number, name) => [`${formatNumber(value, language)}`, String(name)]}
              contentStyle={{ borderRadius: 8, border: "1px solid #E1DFDD", fontSize: 12 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold leading-none text-[#242424]">
            {formatNumber(centerValue, language)}
          </span>
          <span className="mt-1 max-w-[90px] text-center text-[10px] leading-tight text-[#616161]">
            {centerLabel}
          </span>
        </div>
      </div>
      <ul className="w-full min-w-0 space-y-1.5">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: colors[i % colors.length] }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-[#424242]">{d.name}</span>
            <span className="shrink-0 font-semibold text-[#242424]">{formatPercent(d.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

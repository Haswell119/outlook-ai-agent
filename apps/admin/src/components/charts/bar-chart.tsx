"use client";

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AXIS, GRID } from "./palette";

export interface BarDatum {
  name: string;
  value: number;
}

export function SimpleBarChart({
  data,
  color = "#0F6CBD",
  colors,
  layout = "vertical",
  height = 260,
  unit = "",
}: {
  data: BarDatum[];
  color?: string;
  colors?: string[];
  layout?: "vertical" | "horizontal";
  height?: number;
  unit?: string;
}) {
  const isHorizontalBars = layout === "vertical"; // recharts: vertical layout = horizontal bars
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout={isHorizontalBars ? "vertical" : "horizontal"}
          margin={{ top: 8, right: 16, left: isHorizontalBars ? 8 : -18, bottom: 0 }}
        >
          <CartesianGrid stroke={GRID} horizontal={!isHorizontalBars} vertical={isHorizontalBars} />
          {isHorizontalBars ? (
            <>
              <XAxis type="number" tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={150}
                tick={{ fill: AXIS, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
            </>
          ) : (
            <>
              <XAxis dataKey="name" tick={{ fill: AXIS, fontSize: 11 }} axisLine={{ stroke: GRID }} tickLine={false} />
              <YAxis tick={{ fill: AXIS, fontSize: 11 }} axisLine={false} tickLine={false} width={52} />
            </>
          )}
          <Tooltip
            formatter={(v: number) => [`${v}${unit}`, ""]}
            contentStyle={{ borderRadius: 8, border: "1px solid #E1DFDD", fontSize: 12 }}
          />
          <Bar dataKey="value" radius={isHorizontalBars ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={26}>
            {data.map((d, i) => (
              <Cell key={d.name} fill={colors ? (colors[i % colors.length] as string) : color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

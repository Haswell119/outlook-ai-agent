"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Recharts is by far the heaviest dependency of the dashboard (~100 kB gz), and
 * every page that shows a chart would otherwise pay for it in its First Load JS.
 * Loading the chart components on demand keeps each route under the 200 kB gz
 * budget; the server still streams the page, only the chart itself arrives a
 * moment later behind a skeleton of the right height.
 */
const chartSkeleton = (height: number) => {
  const Loading = () => <Skeleton className="w-full rounded-md" style={{ height }} />;
  Loading.displayName = "ChartSkeleton";
  return Loading;
};

export const ActivityChart = dynamic(
  () => import("./activity-chart").then((m) => m.ActivityChart),
  { ssr: false, loading: chartSkeleton(240) },
);

export const DonutChart = dynamic(() => import("./donut-chart").then((m) => m.DonutChart), {
  ssr: false,
  loading: chartSkeleton(220),
});

export const SimpleBarChart = dynamic(() => import("./bar-chart").then((m) => m.SimpleBarChart), {
  ssr: false,
  loading: chartSkeleton(260),
});

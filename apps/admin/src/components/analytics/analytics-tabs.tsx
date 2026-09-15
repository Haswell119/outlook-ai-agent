"use client";

import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQueryParams } from "@/lib/use-query-params";

export type AnalyticsTab = "usage" | "performance" | "impact";

export function AnalyticsTabs({
  active,
  labels,
  usage,
  performance,
  impact,
}: {
  active: AnalyticsTab;
  labels: Record<AnalyticsTab, string>;
  usage: ReactNode;
  performance: ReactNode;
  impact: ReactNode;
}) {
  const { set } = useQueryParams();
  return (
    <Tabs value={active} onValueChange={(v) => set("tab", v)}>
      <TabsList>
        <TabsTrigger value="usage">{labels.usage}</TabsTrigger>
        <TabsTrigger value="performance">{labels.performance}</TabsTrigger>
        <TabsTrigger value="impact">{labels.impact}</TabsTrigger>
      </TabsList>
      <TabsContent value="usage">{usage}</TabsContent>
      <TabsContent value="performance">{performance}</TabsContent>
      <TabsContent value="impact">{impact}</TabsContent>
    </Tabs>
  );
}

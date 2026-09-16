import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@oao/shared";
import { aiLoadBreakdown, estimatedGpuMinutesSaved, eventAiSource } from "@/lib/ai-load";
import { store } from "@/lib/mock-data";

const event = (details: Record<string, unknown>, latencyMs?: number): AuditEvent =>
  ({
    id: "aud-x",
    timestamp: "2025-05-18T10:00:00.000Z",
    user: { id: "u", email: "u@northbridge.example" },
    type: "summary_generated",
    approvalStatus: "auto_approved",
    details,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  }) as AuditEvent;

describe("AI load derived from EmailAnalysis.source", () => {
  it("reads the source from the details, flat or nested", () => {
    expect(eventAiSource(event({ source: "cache" }))).toBe("cache");
    expect(eventAiSource(event({ analysis: { source: "precomputed" } }))).toBe("precomputed");
    expect(eventAiSource(event({ source: "unknown" }))).toBeUndefined();
    expect(eventAiSource(event({}))).toBeUndefined();
  });

  it("computes counts, shares and the avoided model calls", () => {
    const breakdown = aiLoadBreakdown([
      event({ source: "llm" }, 2000),
      event({ source: "llm" }, 4000),
      event({ source: "cache" }),
      event({ source: "precomputed" }),
      event({}),
    ]);
    expect(breakdown.total).toBe(5);
    expect(breakdown.classified).toBe(4);
    expect(breakdown.counts).toEqual({ llm: 2, cache: 1, precomputed: 1, heuristic: 0 });
    expect(breakdown.shares.llm).toBe(50);
    expect(breakdown.avoided).toBe(2);
    expect(breakdown.avgGenerationSeconds).toBe(3);
    expect(estimatedGpuMinutesSaved(breakdown)).toBe(Math.round((2 * 3) / 60));
  });

  it("reports unavailable rather than 0 % when no event carries a source", () => {
    const breakdown = aiLoadBreakdown([event({}), event({ source: "nope" })]);
    expect(breakdown.available).toBe(false);
    expect(breakdown.shares.llm).toBe(0);
    expect(estimatedGpuMinutesSaved(breakdown)).toBe(0);
    expect(aiLoadBreakdown([]).available).toBe(false);
  });

  it("is available on the mock dataset, where most work avoids the GPU", () => {
    const breakdown = aiLoadBreakdown(store().events);
    expect(breakdown.available).toBe(true);
    expect(breakdown.classified).toBeGreaterThan(500);
    expect(breakdown.avoided).toBeGreaterThan(breakdown.counts.llm);
    expect(estimatedGpuMinutesSaved(breakdown)).toBeGreaterThan(0);
  });
});

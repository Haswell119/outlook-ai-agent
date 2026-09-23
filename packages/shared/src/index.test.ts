import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, DecisioningStatusSchema, EmailAnalysisSchema, EmailContextSchema, EmailDecisioningSchema, PolicySchema, SystemStatusSchema, isInternalAddress } from "./index.js";

describe("shared contracts", () => {
  it("parses a minimal email context with defaults", () => {
    const parsed = EmailContextSchema.parse({ id: "abc" });
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe("");
  });

  it("DEFAULT_POLICY is valid", () => {
    expect(() => PolicySchema.parse(DEFAULT_POLICY)).not.toThrow();
  });

  it("detects internal addresses incl. sub-domains", () => {
    expect(isInternalAddress("jane@northbridge.example", ["northbridge.example"])).toBe(true);
    expect(isInternalAddress("jane@mail.northbridge.example", ["northbridge.example"])).toBe(true);
    expect(isInternalAddress("jane@notnorthbridge.example", ["northbridge.example"])).toBe(false);
    expect(isInternalAddress("jane@clientco.com", ["northbridge.example"])).toBe(false);
  });
});

describe("decisioning contracts (optional, backward compatible)", () => {
  const analysis = {
    emailId: "e1",
    language: "fr",
    summary: "s",
    decisions: [],
    pendingTasks: [],
    risks: [],
    suggestedActions: [],
    confidence: 0.8,
    auditId: "a1",
    generatedAt: "2026-09-23T08:00:00.000Z",
  };

  it("an analysis without `decisioning` (older orchestrator) still parses", () => {
    const parsed = EmailAnalysisSchema.parse(analysis);
    expect(parsed.decisioning).toBeUndefined();
  });

  it("parses a full active-mode decisioning block", () => {
    const decisioning = {
      source: "laya",
      mode: "active",
      urgency: { level: "high", confidence: 0.91 },
      businessArea: { id: "operations", label: "Opérations", confidence: 0.88 },
      suggestedFolder: { id: "nav", displayName: "Operations/NAV", outlookFolder: "Operations/NAV", confidence: 0.84, source: "laya" },
      replyExpected: { value: true, confidence: 0.8 },
      actionRequired: { value: true, confidence: 0.9 },
      lowConfidence: false,
      degraded: false,
      model: "multilingual",
      taxonomyVersion: "v1",
      decisionVersion: "v1",
    };
    const parsed = EmailAnalysisSchema.parse({ ...analysis, decisioning });
    expect(parsed.decisioning).toEqual(decisioning);
  });

  it("only source, mode, the two flags and the decision version are mandatory", () => {
    expect(EmailDecisioningSchema.parse({ source: "llm_fallback", mode: "active", lowConfidence: false, degraded: true, fallbackReason: "timeout", decisionVersion: "v1" })).toMatchObject({ degraded: true });
    expect(() => EmailDecisioningSchema.parse({ source: "laya", mode: "active", lowConfidence: false, degraded: false })).toThrow();
    expect(() => EmailDecisioningSchema.parse({ source: "gpt", mode: "active", lowConfidence: false, degraded: false, decisionVersion: "v1" })).toThrow();
    expect(() => EmailDecisioningSchema.parse({ source: "laya", mode: "active", urgency: { level: "urgent", confidence: 0.5 }, lowConfidence: false, degraded: false, decisionVersion: "v1" })).toThrow();
    expect(() => EmailDecisioningSchema.parse({ source: "laya", mode: "active", urgency: { level: "high", confidence: 1.4 }, lowConfidence: false, degraded: false, decisionVersion: "v1" })).toThrow();
  });

  it("the system status keeps parsing without, and with, a decisioning block", () => {
    const base = {
      health: { status: "ok", checks: {}, version: "0.1.0", timestamp: "2026-09-23T08:00:00.000Z" },
      features: { graphEnabled: false, embeddingsEnabled: false, llmProvider: "mock", llmModel: "m", authMode: "dev", version: "0.1.0" },
      llmQueue: { pending: 0, running: 0, concurrency: 4, circuitOpen: false },
      cache: { analysisHits: 0, analysisMisses: 0, embeddingHits: 0, embeddingMisses: 0 },
      uptimeSeconds: 1,
    };
    expect(SystemStatusSchema.parse(base).decisioning).toBeUndefined();
    const decisioning = DecisioningStatusSchema.parse({
      provider: "laya",
      mode: "shadow",
      state: "unavailable",
      circuit: "open",
      modelStrategy: "language",
      decisionVersion: "v1",
      minConfidence: 0.75,
      folderMinConfidence: 0.8,
      fallbackToLlm: true,
      shadowSampleRate: 1,
      concurrency: 1,
      stats: { decisions: 3, providerCalls: 4, failures: 2, fallbacks: 2, lowConfidence: 1, lowConfidenceRate: 1 / 3, inFlight: 0, pending: 0 },
    });
    expect(SystemStatusSchema.parse({ ...base, decisioning }).decisioning?.circuit).toBe("open");
  });
});

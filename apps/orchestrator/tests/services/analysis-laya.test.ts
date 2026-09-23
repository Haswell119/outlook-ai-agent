import { describe, expect, it } from "vitest";
import type { EmailAnalysis, EmailContext } from "@oao/shared";
import { EmailAnalysisSchema } from "@oao/shared";
import { MockDecisionProvider } from "../../src/adapters/decision/mock.js";
import { analysisCacheKey } from "../../src/domain/cacheKey.js";
import type { DecisionProviderRequest } from "../../src/ports/decision.js";
import { createTestContainer, ctx, FakeGraphClient, sampleEmail, user, type TestContainer } from "../helpers.js";

/**
 * The analysis flow with structured decisions (docs/LAYA.md): disabled,
 * shadow and active modes, fallbacks, caching, coalescing, the deterministic
 * folder suggestion — and what must never happen (automatic moves, email text
 * in questions, shadow results shown to the user).
 */

const FR_NAV = (over: Partial<EmailContext> = {}): EmailContext =>
  sampleEmail({
    id: "nav-1",
    conversationId: "conv-nav",
    subject: "Import NAV bloqué pour demain",
    from: { name: "Fund Admin", address: "ops@fundadmin.example" },
    body: "Bonjour,\n\nLe fichier des positions pour l'import NAV ne pourra pas être livré ce soir. Pouvez-vous confirmer le report des valorisations à demain ?\n\nCordialement,\nJean",
    attachments: [],
    ...over,
  });

const EN_NAV = (over: Partial<EmailContext> = {}): EmailContext =>
  FR_NAV({ id: "nav-en", subject: "NAV import blocked for tomorrow", body: "Hello,\n\nThe positions file for the NAV import will not be delivered tonight. Could you please confirm we can postpone the valuations to tomorrow?\n\nBest regards,\nJohn", ...over });

const NEWSLETTER = () => sampleEmail({ id: "nl-1", subject: "Weekly market newsletter", from: { name: "Market News", address: "noreply@news.example" }, body: "This week in markets… Unsubscribe here: https://news.example/unsub", attachments: [] });

/** Mock engine answering with high confidence, operations / nav unless told otherwise. */
const confidentMock = () => new MockDecisionProvider().setAnswer("urgency", "high", 0.9).setAnswer("businessArea", "operations", 0.9).setAnswer("replyExpected", "required", 0.88).setAnswer("actionRequired", "required", 0.86).setAnswer("folder", "nav", 0.87);

async function setup(env: NodeJS.ProcessEnv = {}, mock: MockDecisionProvider = confidentMock(), extra: Parameters<typeof createTestContainer>[1] = {}) {
  const c = await createTestContainer({ DECISION_PROVIDER: "mock", LAYA_MODE: "active", ...env }, { decisionProvider: mock, ...extra });
  return { c, mock };
}

/** Timeline of engine and model calls, to assert on their order. */
function trace(c: TestContainer, mock: MockDecisionProvider): string[] {
  const events: string[] = [];
  const evaluate = mock.evaluate.bind(mock);
  mock.evaluate = async (req: DecisionProviderRequest, context) => {
    events.push(`laya:${Object.keys(req.questions).join(",")}`);
    return evaluate(req, context);
  };
  const complete = c.llm.complete.bind(c.llm);
  c.llm.complete = async (req) => {
    events.push(`llm:${req.useCase}`);
    return complete(req);
  };
  return events;
}

/** The user-visible part of an analysis (what shadow mode must not change). */
const visible = (a: EmailAnalysis) => {
  const { auditId: _a, generatedAt: _g, ...rest } = a;
  void _a;
  void _g;
  return rest;
};

const metricsText = async (c: TestContainer) => (await c.metrics.render()).body;

describe("1. triage — non-conversation emails", () => {
  it("calls neither the engine nor the model", async () => {
    const { c, mock } = await setup();
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: NEWSLETTER(), includeThread: false });
    expect(r.source).toBe("heuristic");
    expect(r.decisioning).toBeUndefined();
    expect(mock.calls).toBe(0);
    expect(c.llm.calls).toBe(0);
    expect(await metricsText(c)).toMatch(/oao_laya_model_calls_saved_total\{reason="triage"\} 1/);
  });
});

describe("2. DECISION_PROVIDER=disabled — historic behaviour", () => {
  it("same answer, same prompt, same cache key, same audit shape as before the integration", async () => {
    const historic = await createTestContainer();
    const disabled = await createTestContainer({ DECISION_PROVIDER: "disabled", LAYA_MODE: "active" });
    const a = await historic.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    const b = await disabled.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(visible(b)).toEqual(visible(a));
    expect(b.decisioning).toBeUndefined();
    expect(disabled.llm.seenUseCases).toEqual(["email_analysis"]);
    expect(disabled.repos.audit.events[0]!.details).not.toHaveProperty("decision");
    const key = analysisCacheKey({ email: FR_NAV(), language: "en", promptVersion: disabled.cfg.PROMPT_VERSION, maxChars: disabled.cfg.LLM_INPUT_MAX_CHARS });
    expect([...disabled.repos.analysisCache.entries.values()].map((e) => e.key)).toEqual([key]);
    expect(disabled.services.emailDecision.enabled).toBe(false);
  });
});

describe("3. shadow mode", () => {
  it("consults the engine, keeps the historic prompt and answer, audits a comparison", async () => {
    const { c, mock } = await setup({ LAYA_MODE: "shadow" });
    const events = trace(c, mock);
    const shadow = await c.services.analyzeEmail.analyze(ctx(undefined, "fr"), { email: FR_NAV(), includeThread: false });
    const reference = await (await createTestContainer()).services.analyzeEmail.analyze(ctx(undefined, "fr"), { email: FR_NAV(), includeThread: false });

    expect(mock.calls).toBe(2); // area + folder, as in active mode
    expect(events).toContain("llm:email_analysis");
    expect(events).not.toContain("llm:email_narrative");
    expect(visible(shadow)).toEqual(visible(reference)); // nothing visible changes
    expect(shadow.decisioning).toBeUndefined();
    expect(shadow.suggestedActions.map((a) => a.type)).not.toContain("move_to_folder");

    const audit = c.repos.audit.events.find((e) => e.type === "summary_generated")!;
    const decision = audit.details.decision as Record<string, unknown>;
    expect(decision).toMatchObject({ mode: "shadow", source: "laya_shadow", status: "ok", consulted: true, promptPath: "full", questions: { businessArea: { choice: "operations" } } });
    expect(decision.shadowComparison).toEqual({ businessArea: expect.any(String), urgency: expect.any(String), replyExpected: expect.any(String), actionRequired: expect.any(String) });
    expect(await metricsText(c)).toMatch(/oao_laya_shadow_comparisons_total\{question="businessArea",result="[a-z]+"\} 1/);
  });

  it("never delays the answer: a slow engine is abandoned shortly after the model answered", async () => {
    const slow = confidentMock();
    slow.latencyMs = 5_000;
    const { c } = await setup({ LAYA_MODE: "shadow" }, slow);
    const started = Date.now();
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.source).toBe("llm");
    const decision = c.repos.audit.events[0]!.details.decision as Record<string, unknown>;
    expect(decision).toMatchObject({ status: "failed", failureKind: "aborted" });
  });

  it("an engine outage in shadow mode changes nothing and does not stop caching", async () => {
    const { c, mock } = await setup({ LAYA_MODE: "shadow" }, new MockDecisionProvider().failWith("network"));
    const first = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    const again = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(first.source).toBe("llm");
    expect(again.source).toBe("cache");
    expect(mock.calls).toBe(1);
  });

  it("LAYA_SHADOW_SAMPLE_RATE=0 never consults the engine", async () => {
    const { c, mock } = await setup({ LAYA_MODE: "shadow", LAYA_SHADOW_SAMPLE_RATE: "0" });
    await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(mock.calls).toBe(0);
    expect((c.repos.audit.events[0]!.details.decision as Record<string, unknown>).consulted).toBe(false);
  });
});

describe("4. active mode, high confidence", () => {
  it("engine first, reduced narrative prompt, decisioning + classification from the engine, a move suggestion", async () => {
    const graph = new FakeGraphClient();
    let graphWrites = 0;
    graph.moveMessage = async () => (graphWrites++, { id: "m" });
    graph.updateCategories = async () => void graphWrites++;
    graph.flagMessage = async () => void graphWrites++;
    const { c, mock } = await setup({}, confidentMock(), { graph });
    const events = trace(c, mock);
    const r = await c.services.analyzeEmail.analyze(ctx(undefined, "fr"), { email: FR_NAV(), includeThread: false });

    expect(events).toEqual(["laya:urgency,businessArea,replyExpected,actionRequired", "laya:folder", "llm:email_narrative"]);
    const prompt = c.llm.requests.at(-1)!.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain("### SYSTEM DECISIONS");
    expect(prompt).toContain("Business area: Opérations");
    expect(prompt).toContain("Suggested folder: Operations/NAV");
    expect(prompt).toContain("Urgency: high");
    expect(prompt).toMatch(/ALREADY DETERMINED/);
    const schema = prompt.slice(prompt.lastIndexOf("JSON schema:"));
    for (const field of ['"classification"', '"urgency"', '"folder"', '"replyExpected"', '"businessArea"', "move_to_folder", "classify_email", "categorize"]) expect(schema).not.toContain(field);

    expect(() => EmailAnalysisSchema.parse(r)).not.toThrow();
    expect(r.source).toBe("llm");
    expect(r.decisioning).toMatchObject({
      source: "laya",
      mode: "active",
      urgency: { level: "high", confidence: 0.9 },
      businessArea: { id: "operations", label: "Opérations", confidence: 0.9 },
      suggestedFolder: { id: "nav", displayName: "Operations/NAV", outlookFolder: "Operations/NAV", confidence: 0.87, source: "laya" },
      replyExpected: { value: true, confidence: 0.88 },
      actionRequired: { value: true, confidence: 0.86 },
      lowConfidence: false,
      degraded: false,
      taxonomyVersion: "v1",
      decisionVersion: "v1",
    });
    expect(r.classification).toEqual({ category: "Operations/NAV", confidence: 0.87 });
    const moves = r.suggestedActions.filter((a) => a.type === "move_to_folder");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.parameters).toMatchObject({ folder: "Operations/NAV", suggested: true, requiresConfirmation: true });
    expect(graphWrites).toBe(0); // analysis never touches the mailbox

    const audit = c.repos.audit.events.find((e) => e.type === "summary_generated")!;
    expect(audit.details.decision).toMatchObject({ mode: "active", source: "laya", promptPath: "narrative", circuit: "closed", stateHash: expect.stringMatching(/^[a-f0-9]{64}$/), taxonomyHash: expect.any(String), model: "multilingual" });
    expect((audit.details.analysis as { decisioning?: unknown }).decisioning).toBeDefined();
  });

  it("the move stays a suggestion: not pre-selected, approval required, never executed on Graph from a folder path", async () => {
    const graph = new FakeGraphClient();
    let graphMoves = 0;
    graph.moveMessage = async () => (graphMoves++, { id: "m" });
    const { c } = await setup({ GRAPH_ENABLED: "true", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "c", AAD_CLIENT_SECRET: "s" }, confidentMock(), { graph });
    const withToken = { ...ctx(user("dev.user@northbridge.example", ["user"], { token: "sso-token" }), "fr") };
    const analysis = await c.services.analyzeEmail.analyze(withToken, { email: FR_NAV(), includeThread: false });
    expect(graphMoves).toBe(0);

    const proposal = await c.services.actions.propose(withToken, { analysisAuditId: analysis.auditId });
    const move = proposal.actions.find((a) => a.type === "move_to_folder")!;
    expect(move).toMatchObject({ requiresApproval: true, selectedByDefault: false, executionTarget: "server", parameters: { folder: "Operations/NAV" } });
    expect(proposal.humanValidationRequired).toBe(true);
    expect(graphMoves).toBe(0);

    // Explicit approval: a folder *path* is not a Graph folder id → the user moves it in Outlook.
    const approved = await c.services.actions.approve(withToken, { proposalId: proposal.proposalId, actionIds: [move.id] });
    expect(approved.results[0]).toMatchObject({ status: "pending_client", clientInstruction: { operation: "openMoveDialog", parameters: { folder: "Operations/NAV" } } });
    expect(graphMoves).toBe(0);
    expect(c.repos.audit.events.filter((e) => e.type === "action_failed")).toHaveLength(0);
  });

  it("a single-folder area needs one engine call and marks the folder as taxonomy-derived", async () => {
    const { c, mock } = await setup({}, confidentMock().setAnswer("businessArea", "accounting", 0.95));
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV({ subject: "Écritures Abacus", body: "Bonjour, pouvez-vous valider les écritures Abacus de septembre ? Merci" }), includeThread: false });
    expect(mock.calls).toBe(1);
    expect(r.decisioning?.suggestedFolder).toMatchObject({ id: "abacus", source: "taxonomy", confidence: 0.95 });
    expect(r.decisioning?.source).toBe("laya");
  });

  it("the model cannot add a competing classification or move: filing actions are dropped from the narrative answer", async () => {
    const { c } = await setup();
    c.llm.nextRawResponse = JSON.stringify({
      language: "en",
      summary: "Fund admin cannot deliver the NAV file tonight.",
      decisions: [],
      pendingTasks: ["Confirm the postponement"],
      risks: [],
      suggestedActions: [
        { type: "move_to_folder", title: "Move to Inbox/Other", description: "x", parameters: { folder: "Other" } },
        { type: "categorize", title: "Tag", description: "x", parameters: { category: "Misc" } },
        { type: "create_task", title: "Confirm", description: "x", parameters: {} },
      ],
      quickReplies: [],
      classification: { category: "Totally different", confidence: 0.99 },
      confidence: 0.8,
    });
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(r.classification).toEqual({ category: "Operations/NAV", confidence: 0.87 });
    expect(r.suggestedActions.filter((a) => a.type === "move_to_folder")).toEqual([expect.objectContaining({ parameters: expect.objectContaining({ folder: "Operations/NAV" }) })]);
    expect(r.suggestedActions.map((a) => a.type)).not.toContain("categorize");
    expect(r.suggestedActions.map((a) => a.type)).toContain("create_task");
  });
});

describe("5. active mode, low confidence", () => {
  it("no folder, historic prompt as fallback, reason recorded", async () => {
    const { c, mock } = await setup({}, confidentMock().setAnswer("businessArea", "operations", 0.5));
    const events = trace(c, mock);
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(events).toEqual(["laya:urgency,businessArea,replyExpected,actionRequired", "llm:email_analysis"]);
    expect(r.decisioning).toMatchObject({ source: "llm_fallback", lowConfidence: true, degraded: false, fallbackReason: "low_confidence" });
    expect(r.decisioning?.businessArea).toBeUndefined();
    expect(r.decisioning?.suggestedFolder).toBeUndefined();
    expect(r.decisioning?.urgency).toEqual({ level: "high", confidence: 0.9 }); // the reliable decisions are kept
    expect(r.suggestedActions.map((a) => a.type)).not.toContain("move_to_folder");
    expect(r.classification).toBeDefined(); // from the historic prompt
    expect(await metricsText(c)).toMatch(/oao_laya_fallbacks_total\{reason="low_confidence"\} 1/);
    expect(await metricsText(c)).toMatch(/oao_laya_low_confidence_total\{question="businessArea"\} 1/);
  });

  it("with LAYA_FALLBACK_TO_LLM=false: narrative only, no classification invented", async () => {
    const { c } = await setup({ LAYA_FALLBACK_TO_LLM: "false" }, confidentMock().setAnswer("businessArea", "operations", 0.5));
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(c.llm.seenUseCases).toEqual(["email_narrative"]);
    expect(r.classification).toBeUndefined();
    expect(r.decisioning).toMatchObject({ source: "laya", lowConfidence: true, fallbackReason: "low_confidence" });
    expect(r.summary.length).toBeGreaterThan(10);
  });

  it("an answer without confidence is not trusted", async () => {
    const { c } = await setup({}, confidentMock().setAnswer("businessArea", "operations", null));
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(r.decisioning).toMatchObject({ source: "llm_fallback", fallbackReason: "missing_confidence" });
  });
});

describe("6. engine unavailable", () => {
  it("the request still succeeds, marked degraded; the breaker opens and stops calling", async () => {
    const mock = new MockDecisionProvider().failWith("network");
    const { c } = await setup({ LAYA_CIRCUIT_FAILURE_THRESHOLD: "2" }, mock);
    for (const [i, expected] of (["network", "network", "circuit_open"] as const).entries()) {
      const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV({ id: `nav-${i}`, subject: `Import NAV bloqué ${i}` }), includeThread: false });
      expect(() => EmailAnalysisSchema.parse(r)).not.toThrow();
      expect(r.decisioning).toMatchObject({ source: "llm_fallback", degraded: true, fallbackReason: expected });
      expect(r.classification).toBeDefined();
      expect(r.source).toBe("llm");
    }
    expect(mock.calls).toBe(2); // the third one was short-circuited
    expect(c.decisionResilience?.circuitState).toBe("open");
    expect(await metricsText(c)).toMatch(/oao_laya_requests_total\{outcome="circuit_open"\} 1/);
  });

  it("a degraded decision is not cached (the next open retries the engine)", async () => {
    const mock = new MockDecisionProvider().failWith("timeout", 1);
    const { c } = await setup({}, mock);
    const first = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    const second = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(first.decisioning?.degraded).toBe(true);
    expect(second.source).toBe("llm");
    expect(second.decisioning).toMatchObject({ degraded: false, source: "laya" });
  });

  it("with LAYA_FALLBACK_TO_LLM=false: rules only for the classification, narrative analysis kept", async () => {
    const { c } = await setup({ LAYA_FALLBACK_TO_LLM: "false" }, new MockDecisionProvider().failWith("server"));
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(r.classification).toBeUndefined();
    expect(r.decisioning).toMatchObject({ source: "heuristic", degraded: true, fallbackReason: "server" });
    expect(c.llm.seenUseCases).toEqual(["email_narrative"]);
  });
});

describe("7. invalid engine answers", () => {
  it("garbage from laya-serve → controlled fallback, no crash", async () => {
    const fetchImpl = (async () => new Response("<html>oops</html>", { status: 200 })) as typeof fetch;
    const c = await createTestContainer({ DECISION_PROVIDER: "laya", LAYA_MODE: "active", LAYA_BASE_URL: "http://laya.test:8000" }, { decisionFetch: fetchImpl });
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(r.decisioning).toMatchObject({ source: "llm_fallback", degraded: true, fallbackReason: "invalid_response" });
    expect(r.summary.length).toBeGreaterThan(10);
  });

  it("an option that was never offered is rejected", async () => {
    const { c } = await setup({}, confidentMock().setAnswer("businessArea", "hr_department", 0.99));
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(r.decisioning).toMatchObject({ source: "llm_fallback", fallbackReason: "unknown_value" });
  });
});

describe("8–9. cache and coalescing", () => {
  it("a cache hit calls neither the engine nor the model, and serves the same decisions", async () => {
    const { c, mock } = await setup();
    const first = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    const [layaCalls, llmCalls] = [mock.calls, c.llm.calls];
    const second = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(second.source).toBe("cache");
    expect(mock.calls).toBe(layaCalls);
    expect(c.llm.calls).toBe(llmCalls);
    expect(second.decisioning).toEqual(first.decisioning);
    expect(second.suggestedActions).toEqual(first.suggestedActions);
    expect(await metricsText(c)).toMatch(/oao_laya_model_calls_saved_total\{reason="cache"\} 1/);
  });

  it("the cache key changes with the decision configuration (mode, thresholds, taxonomy…)", async () => {
    const keys = async (env: NodeJS.ProcessEnv) => {
      const { c } = await setup(env);
      await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
      return [...c.repos.analysisCache.entries.values()].map((e) => e.key)[0];
    };
    const base = await keys({});
    expect(await keys({ LAYA_MODE: "shadow" })).not.toBe(base);
    expect(await keys({ LAYA_MIN_CONFIDENCE: "0.8" })).not.toBe(base);
    expect(await keys({ LAYA_DECISION_VERSION: "v2" })).not.toBe(base);
    expect(await keys({ LAYA_MODEL_STRATEGY: "auto" })).not.toBe(base);
    expect(await keys({})).toBe(base);
  });

  it("identical concurrent requests share one engine + model workflow", async () => {
    const mock = confidentMock();
    mock.latencyMs = 40;
    const { c } = await setup({}, mock);
    const [a, b] = await Promise.all([
      c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false }),
      c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false }),
    ]);
    expect(mock.calls).toBe(2); // one area call + one folder call, once
    expect(c.llm.calls).toBe(1);
    expect(a.decisioning).toEqual(b.decisioning);
    expect(await metricsText(c)).toMatch(/oao_laya_model_calls_saved_total\{reason="coalesced"\} 1/);
  });
});

describe("11. folder action threshold", () => {
  it("no move suggestion below LAYA_FOLDER_MIN_CONFIDENCE, even with a confident area", async () => {
    const { c } = await setup({}, confidentMock().setAnswer("folder", "nav", 0.79));
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false });
    expect(r.decisioning?.businessArea?.id).toBe("operations");
    expect(r.decisioning?.suggestedFolder).toBeUndefined();
    expect(r.classification).toEqual({ category: "Operations", confidence: 0.9 }); // area label, in the reader's language
    expect(r.suggestedActions.map((a) => a.type)).not.toContain("move_to_folder");
  });

  it("no move suggestion for a phishing suspect", async () => {
    const { c } = await setup();
    const phish = FR_NAV({ from: { name: "Northbridge IT", address: "it-support@northbridqe-finance.com" }, subject: "URGENT: import NAV", body: "Verify your account immediately at http://185.203.116.42/owa and confirm your password to unblock the NAV import. Final notice." });
    const r = await c.services.analyzeEmail.analyze(ctx(), { email: phish, includeThread: false });
    expect(r.phishing?.verdict).not.toBe("clean");
    expect(r.suggestedActions.map((a) => a.type)).not.toContain("move_to_folder");
    expect(r.suggestedActions.map((a) => a.type)).toContain("escalate_compliance");
  });
});

describe("12. checkpoint per language", () => {
  const firstModel = async (env: NodeJS.ProcessEnv, email: EmailContext) => {
    const { c, mock } = await setup(env);
    await c.services.analyzeEmail.analyze(ctx(), { email, includeThread: false });
    return { model: mock.requests[0]!.model, has: "model" in mock.requests[0]! && mock.requests[0]!.model !== undefined };
  };

  it("english → english, français → multilingual, inconnu → multilingual, auto → no model, fixed → configured", async () => {
    expect((await firstModel({}, EN_NAV())).model).toBe("english");
    expect((await firstModel({}, FR_NAV())).model).toBe("multilingual");
    expect((await firstModel({}, FR_NAV({ subject: "Positionen", body: "Die Positionsdatei für den NAV-Import fehlt, bitte prüfen und bestätigen Sie die Verschiebung. Grüße" }))).model).toBe("multilingual");
    expect(await firstModel({ LAYA_MODEL_STRATEGY: "auto" }, EN_NAV())).toEqual({ model: undefined, has: false });
    expect((await firstModel({ LAYA_MODEL_STRATEGY: "fixed", LAYA_FIXED_MODEL: "multilingual" }, EN_NAV())).model).toBe("multilingual");
  });

  it("background precomputation reaches the engine in the background lane", async () => {
    const { c, mock } = await setup();
    await c.services.analyzeEmail.analyze(ctx(), { email: FR_NAV(), includeThread: false }, { priority: "background" });
    expect(mock.contexts[0]).toMatchObject({ priority: "background", correlationId: "test-corr" });
  });
});

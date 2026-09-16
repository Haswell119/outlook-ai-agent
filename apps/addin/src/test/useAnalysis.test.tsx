/**
 * The AI-load minimisation policy is the whole point of the pane, so it is
 * asserted directly rather than through the UI: which of the three tiers was
 * used, and how many model calls each path costs.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAnalysis } from "@oao/shared";
import { setCacheStore } from "@/cache/analysisCache";
import { memoryStore } from "./memoryStore";
import { useAnalysis } from "@/features/summary/useAnalysis";
import { mockAnalysis, mockTriagedAnalysis } from "@/api/mock";
import { sampleEmail } from "@/office/sample";
import type { OaoApi } from "@/api";

function stubApi(overrides: Partial<OaoApi> = {}) {
  const analysisByEmail = vi.fn<(id: string) => Promise<EmailAnalysis | null>>().mockResolvedValue(null);
  const analyzeEmail = vi.fn().mockResolvedValue({ ...mockAnalysis("en", sampleEmail.id), source: "llm" as const });
  return { mode: "mock", analysisByEmail, analyzeEmail, ...overrides } as unknown as OaoApi & {
    analysisByEmail: typeof analysisByEmail;
    analyzeEmail: typeof analyzeEmail;
  };
}

const render = (api: OaoApi, lang: "en" | "fr" = "en") =>
  renderHook(() => useAnalysis({ api, email: sampleEmail, lang, stableIdOf: (id) => `rest-${id}` }));

describe("analysis resolution tiers", () => {
  beforeEach(() => setCacheStore(memoryStore()));

  it("tier 2: a precomputed analysis renders without any model call", async () => {
    const api = stubApi();
    api.analysisByEmail.mockResolvedValue({ ...mockAnalysis("en", sampleEmail.id), source: "precomputed" });

    const { result } = render(api);
    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(result.current.source).toBe("precomputed");
    expect(api.analysisByEmail).toHaveBeenCalledWith(`rest-${sampleEmail.id}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.analyzeEmail).not.toHaveBeenCalled();
  });

  it("tier 3: a 404 (null) falls through to exactly one model call", async () => {
    const api = stubApi();
    const { result } = render(api);
    await waitFor(() => expect(result.current.data).not.toBeNull());

    expect(result.current.source).toBe("llm");
    expect(api.analyzeEmail).toHaveBeenCalledOnce();
  });

  it("tier 1: a second mount of the same email hits the local cache, not the network", async () => {
    const api = stubApi();
    const first = render(api);
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    expect(api.analyzeEmail).toHaveBeenCalledOnce();
    first.unmount();

    const second = render(api);
    await waitFor(() => expect(second.result.current.source).toBe("local"));
    expect(api.analyzeEmail).toHaveBeenCalledOnce();
    expect(api.analysisByEmail).toHaveBeenCalledOnce();
  });

  it("refresh bypasses every cache and spends one model call", async () => {
    const api = stubApi();
    api.analysisByEmail.mockResolvedValue({ ...mockAnalysis("en", sampleEmail.id), source: "precomputed" });
    const { result } = render(api);
    await waitFor(() => expect(result.current.source).toBe("precomputed"));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.source).toBe("llm"));
    expect(api.analyzeEmail).toHaveBeenCalledOnce();
    // The refresh must not consult the precomputed endpoint again.
    expect(api.analysisByEmail).toHaveBeenCalledOnce();
  });

  it("a triaged email costs nothing until the user asks for it", async () => {
    const api = stubApi();
    api.analysisByEmail.mockResolvedValue(mockTriagedAnalysis("en", sampleEmail.id));
    const { result } = render(api);
    await waitFor(() => expect(result.current.data?.triage?.kind).toBe("newsletter"));
    expect(api.analyzeEmail).not.toHaveBeenCalled();

    await act(async () => {
      result.current.analyseAnyway();
    });
    await waitFor(() => expect(api.analyzeEmail).toHaveBeenCalledOnce());
    expect(result.current.source).toBe("llm");
  });

  it("does not serve a precomputed analysis written in another language", async () => {
    const api = stubApi();
    api.analysisByEmail.mockResolvedValue({ ...mockAnalysis("en", sampleEmail.id), source: "precomputed", language: "en" });
    api.analyzeEmail.mockResolvedValue({ ...mockAnalysis("fr", sampleEmail.id), source: "llm" as const });

    const { result } = render(api, "fr");
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.language).toBe("fr");
    expect(api.analyzeEmail).toHaveBeenCalledOnce();
  });

  it("surfaces an error without wiping a previous result", async () => {
    const api = stubApi();
    api.analyzeEmail.mockRejectedValueOnce(new Error("backend down"));
    const { result } = render(api);
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

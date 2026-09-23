import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { EmailAnalysisSchema, type EmailAnalysis, type EmailDecisioning } from "@oao/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockAnalysis } from "@/api/mock";
import { loadSettings, resetSettings, saveSettings } from "@/app/settings";
import { SettingsSheet } from "@/features/settings/SettingsSheet";
import { DecisionCard } from "@/features/summary/DecisionCard";
import { SummaryTab } from "@/features/summary/SummaryTab";
import type { AnalysisState } from "@/features/summary/useAnalysis";
import { sampleEmail } from "@/office/sample";
import { renderWithProviders } from "./render";

const active = (over: Partial<EmailDecisioning> = {}): EmailDecisioning => ({
  source: "laya",
  mode: "active",
  urgency: { level: "high", confidence: 0.91 },
  businessArea: { id: "operations", label: "Operations", confidence: 0.88 },
  suggestedFolder: { id: "nav", displayName: "Operations/NAV", outlookFolder: "Operations/NAV", confidence: 0.84, source: "laya" },
  replyExpected: { value: true, confidence: 0.8 },
  lowConfidence: false,
  degraded: false,
  model: "multilingual",
  taxonomyVersion: "v1",
  decisionVersion: "v1",
  ...over,
});

const state = (data: EmailAnalysis): AnalysisState => ({
  data,
  error: null,
  loading: false,
  source: "llm",
  ageMs: undefined,
  refresh: () => undefined,
  analyseAnyway: () => undefined,
  revalidating: false,
  forced: false,
  subject: sampleEmail.subject,
});

beforeEach(() => resetSettings());
afterEach(() => resetSettings());

describe("structured decision card", () => {
  it("the Summary is unchanged when the analysis has no decisioning (engine disabled / shadow)", () => {
    const analysis = mockAnalysis("en", sampleEmail.id);
    expect(analysis.decisioning).toBeUndefined();
    renderWithProviders(<SummaryTab email={sampleEmail} state={state(analysis)} />);
    expect(screen.getByTestId("summary-card")).toBeInTheDocument();
    expect(screen.queryByTestId("decision-card")).not.toBeInTheDocument();
  });

  it("shows urgency, area, folder and confidence — never the source outside diagnostic mode", () => {
    const analysis = EmailAnalysisSchema.parse({ ...mockAnalysis("en", sampleEmail.id), decisioning: active() });
    renderWithProviders(<SummaryTab email={sampleEmail} state={state(analysis)} />);
    expect(screen.getByTestId("decision-card")).toBeInTheDocument();
    expect(screen.getByTestId("decision-urgency-level")).toHaveAttribute("data-level", "high");
    expect(screen.getByTestId("decision-urgency-level")).toHaveTextContent("High");
    expect(screen.getByTestId("decision-urgency-confidence")).toHaveTextContent("91% confidence");
    expect(screen.getByTestId("decision-area")).toHaveTextContent("Operations");
    expect(screen.getByTestId("decision-folder")).toHaveTextContent("Operations/NAV");
    expect(screen.getByTestId("decision-folder-confidence")).toHaveTextContent("84%");
    expect(screen.getByTestId("decision-reply")).toHaveTextContent("Yes");
    expect(screen.queryByTestId("decision-action")).not.toBeInTheDocument();
    expect(screen.getByText(/nothing is moved without your approval/)).toBeInTheDocument();
    expect(screen.queryByTestId("decision-low-confidence")).not.toBeInTheDocument();
    expect(screen.queryByTestId("decision-diagnostics")).not.toBeInTheDocument();
    expect(screen.queryByText("Local decision engine")).not.toBeInTheDocument();
  });

  it("flags low confidence and only shows what passed the policy", () => {
    renderWithProviders(<DecisionCard decisioning={active({ suggestedFolder: undefined, replyExpected: undefined, lowConfidence: true, fallbackReason: "low_confidence" })} />);
    expect(screen.getByTestId("decision-low-confidence")).toHaveTextContent(/Low confidence/);
    expect(screen.queryByTestId("decision-folder")).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing is moved/)).not.toBeInTheDocument();
    expect(screen.queryByText("low_confidence")).not.toBeInTheDocument();
  });

  it("diagnostic mode adds the source, the fallback reason and the versions — and follows the setting live", () => {
    renderWithProviders(<DecisionCard decisioning={active({ suggestedFolder: { id: "general", displayName: "Infrastructure", outlookFolder: "Infrastructure", confidence: 0.88, source: "taxonomy" } })} />);
    expect(screen.queryByTestId("decision-diagnostics")).not.toBeInTheDocument();
    act(() => void saveSettings({ diagnostics: true }));
    expect(screen.getByTestId("decision-source")).toHaveTextContent("Local decision engine");
    expect(screen.getByText("Taxonomy (single folder)")).toBeInTheDocument();
    expect(screen.getByTestId("decision-diagnostics")).toHaveTextContent("multilingual");
    expect(screen.getByTestId("decision-diagnostics")).toHaveTextContent("v1 · taxonomy v1");
    act(() => void saveSettings({ diagnostics: false }));
    expect(screen.queryByTestId("decision-diagnostics")).not.toBeInTheDocument();
  });

  it("an engine failure with nothing decided shows nothing to the user, the reason in diagnostic mode", () => {
    const failed = active({ source: "llm_fallback", urgency: undefined, businessArea: undefined, suggestedFolder: undefined, replyExpected: undefined, degraded: true, fallbackReason: "timeout", model: undefined });
    const { unmount } = renderWithProviders(<DecisionCard decisioning={failed} />);
    expect(screen.queryByTestId("decision-card")).not.toBeInTheDocument();
    unmount();
    saveSettings({ diagnostics: true });
    renderWithProviders(<DecisionCard decisioning={failed} />);
    expect(screen.getByTestId("decision-source")).toHaveTextContent("AI model (fallback)");
    expect(screen.getByTestId("decision-diagnostics")).toHaveTextContent("Engine unavailable for this email");
    expect(screen.getByTestId("decision-diagnostics")).toHaveTextContent("timeout");
  });

  it("shadow decisions are never displayed", () => {
    saveSettings({ diagnostics: true });
    renderWithProviders(<DecisionCard decisioning={active({ mode: "shadow", source: "laya_shadow" })} />);
    expect(screen.queryByTestId("decision-card")).not.toBeInTheDocument();
  });

  it("renders the French strings", () => {
    renderWithProviders(<DecisionCard decisioning={active({ urgency: { level: "critical", confidence: 0.97 }, actionRequired: { value: false, confidence: 0.9 }, lowConfidence: true })} />, { lang: "fr" });
    expect(screen.getByText("Décision structurée")).toBeInTheDocument();
    expect(screen.getByTestId("decision-urgency-level")).toHaveTextContent("Critique");
    expect(screen.getByTestId("decision-urgency-confidence")).toHaveTextContent("confiance 97%");
    expect(screen.getByTestId("decision-action")).toHaveTextContent("Non");
    expect(screen.getByTestId("decision-low-confidence")).toHaveTextContent(/Confiance faible/);
    expect(screen.getByText(/rien n'est déplacé sans votre validation/)).toBeInTheDocument();
  });

  it("the settings sheet toggles diagnostic mode (off by default, stored on this device only)", async () => {
    expect(loadSettings().diagnostics).toBe(false);
    renderWithProviders(<SettingsSheet open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("settings-health")).toHaveTextContent("Healthy"));
    const toggle = screen.getByTestId("settings-diagnostics").querySelector("input") ?? screen.getByTestId("settings-diagnostics");
    fireEvent.click(toggle);
    expect(loadSettings().diagnostics).toBe(true);
  });
});

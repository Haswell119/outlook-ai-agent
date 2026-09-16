import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DailyBriefView } from "@/features/brief/DailyBriefView";
import { SyncStatusPill } from "@/features/insights/SyncStatusPill";
import { TriageCard } from "@/features/summary/TriageCard";
import { isCompactTriage, COMPACT_TRIAGE_KINDS } from "@/features/summary/useAnalysis";
import { SourceBadge } from "@/ui/SourceBadge";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { mockTriagedAnalysis } from "@/api/mock";
import { mockDailyBrief, mockSyncStatus } from "@/api/mockBrief";
import { renderWithProviders } from "./render";

describe("triage layout", () => {
  it("shows a one-line summary and an explicit Analyse anyway button", () => {
    const analysis = mockTriagedAnalysis("en", "msg-newsletter-1");
    const onAnalyse = vi.fn();
    renderWithProviders(<TriageCard analysis={analysis} source="heuristic" onAnalyseAnyway={onAnalyse} />);

    const card = screen.getByTestId("triage-card");
    expect(card).toHaveAttribute("data-kind", "newsletter");
    expect(screen.getByText("Newsletter")).toBeInTheDocument();
    expect(screen.getByText(/Weekly market commentary/)).toBeInTheDocument();
    expect(screen.getByText(/List-Unsubscribe header/)).toBeInTheDocument();
    // No decisions / tasks / risks cards for a triaged email.
    expect(screen.queryByText("Decisions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("suggested-actions")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("analyse-anyway"));
    expect(onAnalyse).toHaveBeenCalledOnce();
  });

  it("only treats low-value kinds as compact", () => {
    expect(isCompactTriage(mockTriagedAnalysis("en", "x", "newsletter"))).toBe(true);
    expect(isCompactTriage(mockTriagedAnalysis("en", "x", "notification"))).toBe(true);
    expect(isCompactTriage(mockTriagedAnalysis("en", "x", "out_of_office"))).toBe(true);
    expect(isCompactTriage(mockTriagedAnalysis("en", "x", "conversation"))).toBe(false);
    expect(isCompactTriage(null)).toBe(false);
    expect(COMPACT_TRIAGE_KINDS.has("conversation")).toBe(false);
  });

  it("renders the FR strings", () => {
    renderWithProviders(<TriageCard analysis={mockTriagedAnalysis("fr", "x")} source="heuristic" onAnalyseAnyway={() => undefined} />, { lang: "fr" });
    expect(screen.getByText("Newsletter")).toBeInTheDocument();
    expect(screen.getByTestId("analyse-anyway")).toHaveTextContent("Analyser quand même");
  });
});

describe("source badge", () => {
  it("labels precomputed, cached and model-generated results differently", () => {
    const { unmount } = renderWithProviders(<SourceBadge source="precomputed" />);
    expect(screen.getByTestId("source-badge")).toHaveTextContent("Precomputed");
    unmount();

    renderWithProviders(<SourceBadge source="local" ageMs={5 * 60_000} />);
    expect(screen.getByTestId("source-badge")).toHaveTextContent("From cache");
  });

  it("renders nothing without a source", () => {
    renderWithProviders(<SourceBadge source={undefined} />);
    expect(screen.queryByTestId("source-badge")).not.toBeInTheDocument();
  });
});

describe("daily brief", () => {
  it("renders the headline, priority emails, tasks, deadlines, alerts and stats", async () => {
    renderWithProviders(<DailyBriefView brief={mockDailyBrief("en")} />);

    expect(await screen.findByTestId("daily-brief")).toBeInTheDocument();
    expect(screen.getByTestId("brief-headline")).toHaveTextContent("3 items need you today");
    expect(screen.getByTestId("brief-highlights")).toHaveTextContent("signed Account Mandate");
    expect(screen.getAllByTestId("brief-email")).toHaveLength(3);
    expect(screen.getByTestId("brief-tasks")).toHaveTextContent("Obtain the signed Account Mandate");
    expect(screen.getByTestId("brief-deadlines")).toHaveTextContent("Target onboarding date");
    expect(screen.getByTestId("brief-alerts")).toHaveTextContent("1 suspicious inbound email");
    expect(screen.getByTestId("brief-stats")).toHaveTextContent("42");
    expect(screen.getByTestId("brief-regenerate")).toBeInTheDocument();
  });

  it("asks for confirmation before spending a model call", async () => {
    renderWithProviders(<DailyBriefView brief={mockDailyBrief("en")} />);
    fireEvent.click(await screen.findByTestId("brief-regenerate"));
    expect(await screen.findByText("Regenerate the daily brief?")).toBeInTheDocument();
    expect(screen.getByText(/costs one/)).toBeInTheDocument();
  });

  it("renders in French", async () => {
    renderWithProviders(<DailyBriefView brief={mockDailyBrief("fr")} />, { lang: "fr" });
    expect(await screen.findByTestId("brief-highlights")).toHaveTextContent("mandat de compte signé");
    expect(screen.getByText("Ce qui compte aujourd'hui")).toBeInTheDocument();
  });
});

describe("sync status", () => {
  it("shows the last sync time and the precomputed count", async () => {
    renderWithProviders(<SyncStatusPill status={mockSyncStatus({ precomputedAnalyses: 317, pending: 4 })} />);
    expect(await screen.findByTestId("sync-status")).toBeInTheDocument();
    expect(screen.getByTestId("sync-pill")).toHaveAttribute("data-state", "idle");
    expect(screen.getByTestId("sync-precomputed")).toHaveTextContent("317");
    expect(screen.getByTestId("sync-now")).toBeEnabled();
  });

  it("explains itself instead of erroring when sync is off", async () => {
    renderWithProviders(<SyncStatusPill status={mockSyncStatus({ enabled: false, state: "disabled" })} />);
    expect(await screen.findByText(/Mailbox sync is off/)).toBeInTheDocument();
    expect(screen.getByTestId("sync-now")).toBeDisabled();
  });
});

describe("error boundary", () => {
  function Boom(): JSX.Element {
    throw Object.assign(new Error("kaboom"), { correlationId: "corr-boundary" });
  }

  it("catches a feature crash, offers a retry and copies a report", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderWithProviders(
      <ErrorBoundary feature="chat">
        <Boom />
      </ErrorBoundary>,
    );

    const boundary = screen.getByTestId("error-boundary");
    expect(boundary).toHaveAttribute("data-feature", "chat");
    expect(screen.getByText("This section could not be displayed")).toBeInTheDocument();
    expect(boundary).toHaveTextContent("corr-boundary");

    fireEvent.click(screen.getByTestId("error-report"));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(String(writeText.mock.calls[0]![0])).toContain("corr-boundary");
    expect(screen.getByTestId("error-retry")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("renders the FR recovery message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderWithProviders(
      <ErrorBoundary feature="insights">
        <Boom />
      </ErrorBoundary>,
      { lang: "fr" },
    );
    expect(screen.getByText("Cette section n'a pas pu être affichée")).toBeInTheDocument();
    spy.mockRestore();
  });

  it("renders children untouched when nothing throws", () => {
    renderWithProviders(
      <ErrorBoundary feature="summary">
        <div data-testid="ok">fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("ok")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary")).not.toBeInTheDocument();
  });
});

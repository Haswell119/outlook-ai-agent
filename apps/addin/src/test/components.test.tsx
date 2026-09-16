import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfidenceBar } from "@/ui/ConfidenceBar";
import { ActionApprovalDialog } from "@/features/actions/ActionApprovalDialog";
import { ComplianceIssueRow } from "@/features/compliance/ComplianceGuardian";
import { mockComplianceIssues, mockProposal } from "@/api/mock";
import { renderWithProviders } from "./render";

describe("ConfidenceBar", () => {
  it("renders the percentage", () => {
    renderWithProviders(<ConfidenceBar value={0.92} />);
    expect(screen.getByTestId("confidence-value")).toHaveTextContent("92%");
    expect(screen.getByText("AI confidence")).toBeInTheDocument();
  });
});

describe("ActionApprovalDialog", () => {
  it("counts selected actions and updates when one is unchecked", () => {
    const proposal = mockProposal("en");
    renderWithProviders(<ActionApprovalDialog open onClose={() => undefined} proposal={proposal} />);
    expect(screen.getByTestId("proposed-count")).toHaveTextContent("5 proposed actions");
    const button = screen.getByTestId("approve-button");
    expect(button).toHaveTextContent("Approve selected actions (5)");
    const first = screen.getByRole("checkbox", { name: proposal.actions[0]!.title });
    fireEvent.click(first);
    expect(button).toHaveTextContent("Approve selected actions (4)");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(button).toHaveTextContent("Approve selected actions (5)");
  });
});

describe("Compliance issue rows", () => {
  it("render titles and severity badges", () => {
    const issues = mockComplianceIssues("en");
    renderWithProviders(
      <div>
        {issues.map((i) => (
          <ComplianceIssueRow key={i.id} issue={i} />
        ))}
      </div>,
    );
    const rows = screen.getAllByTestId("compliance-issue");
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("data-severity"))).toEqual(["high", "high", "medium", "high"]);
    expect(within(rows[0]!).getByTestId("risk-badge-high")).toHaveTextContent("High");
    expect(within(rows[2]!).getByTestId("risk-badge-medium")).toHaveTextContent("Medium");
    expect(screen.getByText("External recipient detected")).toBeInTheDocument();
  });
});

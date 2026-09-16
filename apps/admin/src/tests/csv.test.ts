import { describe, expect, it } from "vitest";
import { AUDIT_CSV_COLUMNS, auditEventsToCsv, escapeCsvCell, toCsv } from "@/lib/csv";
import { store } from "@/lib/mock-data";

describe("CSV export util", () => {
  it("quotes separators, newlines and doubles inner quotes", () => {
    expect(escapeCsvCell("plain")).toBe("plain");
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell(null)).toBe("");
  });

  it("neutralises spreadsheet formula injection", () => {
    expect(escapeCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeCsvCell("+1")).toBe("'+1");
  });

  it("writes a header row and CRLF-separated records", () => {
    const csv = toCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }]);
    expect(csv.split("\r\n")).toEqual(["a,b", "1,x", "2,y"]);
  });

  it("exports audit events with the documented column order", () => {
    const events = store().events.slice(0, 3);
    const csv = auditEventsToCsv(events);
    const lines = csv.split("\r\n");

    expect(lines[0]).toBe(AUDIT_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(events[0]!.id);
    expect(lines[1]).toContain(events[0]!.user.email);
  });
});

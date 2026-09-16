/**
 * Regression tests for the findings of the 2026-09 security review.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { safeExternalLink } from "@oao/shared";
import { openMessage } from "@/office/actions";

afterEach(() => vi.restoreAllMocks());

/**
 * `webLink` arrives as a plain string from Office.js / Graph and was handed
 * straight to `window.open`. In the WebViews Outlook embeds, a `javascript:`
 * URL there executes in the task pane's own origin — script execution from an
 * email, triggered by clicking "Open original email".
 */
describe("openMessage refuses a non-http(s) deep link", () => {
  it("opens a normal Outlook web link", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openMessage("id-1", "https://outlook.office.com/mail/inbox/id/AAA")).toBe(true);
    expect(open).toHaveBeenCalledWith("https://outlook.office.com/mail/inbox/id/AAA", "_blank", "noopener");
  });

  it("never opens javascript:, data: or vbscript: links", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    for (const evil of ["javascript:alert(1)", "data:text/html,<script>1</script>", "vbscript:msgbox", "  JaVaScRiPt:alert(1)"]) {
      // Falls through to the Office.js path, which is unavailable in the test env.
      expect(openMessage(undefined, evil)).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
  });
});

describe("safeExternalLink", () => {
  it("keeps absolute http(s) URLs and drops everything else", () => {
    expect(safeExternalLink("https://outlook.office.com/x")).toBe("https://outlook.office.com/x");
    expect(safeExternalLink("http://intranet.northbridge.example/x")).toBe("http://intranet.northbridge.example/x");
    expect(safeExternalLink("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalLink("data:text/html,x")).toBeUndefined();
    expect(safeExternalLink("file:///etc/passwd")).toBeUndefined();
    expect(safeExternalLink("/relative/path")).toBeUndefined();
    expect(safeExternalLink("")).toBeUndefined();
    expect(safeExternalLink(undefined)).toBeUndefined();
  });
});

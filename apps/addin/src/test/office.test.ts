import { afterEach, describe, expect, it, vi } from "vitest";
import { hasSelectedItem, isSetSupported, looksLikeRestId, toStableEmailId } from "@/office/env";
import { diagnoseSso, parseJwtExpiry, SSO_ERRORS, SsoError } from "@/office/sso";
import { buildSendMessage, buildSendOptions } from "@/commands/commands";
import { COMPOSE_PANE_COMMAND_ID } from "@/office/notifications";

type OfficeStub = {
  context?: {
    mailbox?: { convertToRestId?: (id: string, v: unknown) => string; item?: unknown };
    requirements?: { isSetSupported: (name: string, version: string) => boolean };
  };
  MailboxEnums?: { RestVersion?: { v2_0?: string } };
};

function withOffice(stub: OfficeStub | undefined, run: () => void): void {
  const original = (globalThis as { Office?: unknown }).Office;
  Object.defineProperty(globalThis, "Office", { value: stub, configurable: true, writable: true });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, "Office", { value: original, configurable: true, writable: true });
  }
}

const REST_ID = "AAMkAGI2THVSAAA".repeat(6);

afterEach(() => vi.restoreAllMocks());

describe("stable email id conversion", () => {
  it("converts the EWS itemId to a REST v2.0 id when Mailbox 1.3 is supported", () => {
    const convertToRestId = vi.fn().mockReturnValue(REST_ID);
    withOffice(
      {
        context: { mailbox: { convertToRestId }, requirements: { isSetSupported: () => true } },
        MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
      },
      () => {
        expect(toStableEmailId("AAkALgAAAAA=")).toBe(REST_ID);
        expect(convertToRestId).toHaveBeenCalledWith("AAkALgAAAAA=", "v2.0");
      },
    );
  });

  it("falls back to the raw itemId when the requirement set is missing", () => {
    const convertToRestId = vi.fn().mockReturnValue(REST_ID);
    withOffice(
      {
        context: { mailbox: { convertToRestId }, requirements: { isSetSupported: () => false } },
        MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
      },
      () => {
        expect(toStableEmailId("raw-item-id")).toBe("raw-item-id");
        expect(convertToRestId).not.toHaveBeenCalled();
      },
    );
  });

  it("falls back when convertToRestId throws, returns an empty string or is absent", () => {
    withOffice(
      {
        context: {
          mailbox: {
            convertToRestId: () => {
              throw new Error("no id yet");
            },
          },
          requirements: { isSetSupported: () => true },
        },
        MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
      },
      () => expect(toStableEmailId("raw")).toBe("raw"),
    );
    withOffice(
      {
        context: { mailbox: { convertToRestId: () => "" }, requirements: { isSetSupported: () => true } },
        MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
      },
      () => expect(toStableEmailId("raw")).toBe("raw"),
    );
    withOffice(undefined, () => expect(toStableEmailId("raw")).toBe("raw"));
  });

  it("returns an empty string for a missing id and never throws", () => {
    withOffice(undefined, () => {
      expect(toStableEmailId(undefined)).toBe("");
      expect(toStableEmailId("  ")).toBe("");
      expect(isSetSupported("Mailbox", "1.3")).toBe(false);
      expect(hasSelectedItem()).toBe(false);
    });
  });

  it("recognises REST-shaped ids", () => {
    expect(looksLikeRestId(REST_ID)).toBe(true);
    expect(looksLikeRestId("short")).toBe(false);
  });
});

describe("SSO hardening", () => {
  it("maps every documented error code to an actionable diagnosis", () => {
    for (const code of [13000, 13001, 13002, 13003, 13004, 13005, 13006, 13007, 13008, 13009, 13010, 13012, 13013]) {
      const d = diagnoseSso(code);
      expect(d, `code ${code}`).not.toBeNull();
      expect(d!.i18nKey).toBe(`errors.sso.${code}`);
    }
    expect(SSO_ERRORS[13001]!.retryable).toBe(true);
    expect(SSO_ERRORS[13005]!.needsAdmin).toBe(true);
    expect(diagnoseSso(99999)!.i18nKey).toBe("errors.sso.generic");
    expect(diagnoseSso(undefined)).toBeNull();
  });

  it("parses the JWT expiry and tolerates opaque tokens", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp, aud: "api://x" })).toString("base64url");
    expect(parseJwtExpiry(`header.${payload}.sig`)).toBe(exp * 1000);
    expect(parseJwtExpiry("not-a-jwt")).toBeNull();
    expect(parseJwtExpiry("a.!!!.c")).toBeNull();
  });

  it("carries the office error code on the thrown error", () => {
    const err = new SsoError("nope", 13002);
    expect(err.officeErrorCode).toBe(13002);
    expect(err.diagnosis?.retryable).toBe(true);
  });
});

describe("Smart Alerts send options", () => {
  it("keeps a warning overridable and points the dialog at the compose pane", () => {
    const options = buildSendOptions({
      verdict: "warn",
      errorMessage: "issues",
      supportsOverride: true,
      promptUserOverride: "promptUser",
      issueCount: 4,
    });
    expect(options.allowEvent).toBe(false);
    expect(options.sendModeOverride).toBe("promptUser");
    expect(options.commandId).toBe(COMPOSE_PANE_COMMAND_ID);
  });

  it("does not override the manifest SendMode for a blocking verdict", () => {
    const options = buildSendOptions({ verdict: "block", errorMessage: "x", supportsOverride: true, promptUserOverride: "promptUser", issueCount: 1 });
    expect(options.sendModeOverride).toBeUndefined();
    expect(options.commandId).toBe(COMPOSE_PANE_COMMAND_ID);
  });

  it("omits 1.14-only options on older hosts", () => {
    const options = buildSendOptions({ verdict: "warn", errorMessage: "x", supportsOverride: false, promptUserOverride: "promptUser", issueCount: 1 });
    expect(options.commandId).toBeUndefined();
    expect(options.sendModeOverride).toBeUndefined();
    expect(options.allowEvent).toBe(false);
  });

  it("lists at most five issues and says how many were hidden", () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({ title: `Issue ${i + 1}`, severity: "high" as const }));
    const message = buildSendMessage("en", issues);
    expect(message).toContain("7 compliance issues detected");
    expect(message).toContain("Issue 5");
    expect(message).not.toContain("Issue 6 (");
    expect(message).toContain("and 2 more");
  });
});

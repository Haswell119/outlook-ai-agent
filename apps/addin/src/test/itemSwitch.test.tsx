/**
 * Regression tests for the bugs the Office.js host simulator turned up
 * (`e2e/office-sim/`, driven by `e2e/sim.spec.ts`).
 *
 * The common theme is identity: everything on the read surface belongs to *one*
 * message, and the pane must never render a value that belongs to another one —
 * not for a frame, not while a slow read is in flight, and not because the host
 * swapped the item without telling us.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAnalysis, EmailContext } from "@oao/shared";
import { cacheKey, setCacheStore } from "@/cache/analysisCache";
import { memoryStore } from "./memoryStore";
import { useAsync } from "@/app/useAsync";
import { useAnalysis, isDegraded, isEmptyAnalysis, DEGRADED_RISK_CODE } from "@/features/summary/useAnalysis";
import { mockAnalysis } from "@/api/mock";
import { sampleEmail, sampleNewsletter } from "@/office/sample";
import { currentItemId, currentItemSubject, NoItemError, readCurrentItem } from "@/office/readItem";
import { readCompose } from "@/office/readCompose";
import { toPlainText, looksLikeHtml } from "@/security/sanitize";
import type { OaoApi } from "@/api";

/* ------------------------------------------------------------------ */
/* a minimal Office stand-in (the full behaviour lives in e2e/office-sim) */
/* ------------------------------------------------------------------ */

type Stub = Record<string, unknown> | undefined;

function withOffice(stub: Stub, run: () => void | Promise<void>): void | Promise<void> {
  const original = (globalThis as { Office?: unknown }).Office;
  Object.defineProperty(globalThis, "Office", { value: stub, configurable: true, writable: true });
  const restore = () => Object.defineProperty(globalThis, "Office", { value: original, configurable: true, writable: true });
  let result: void | Promise<void>;
  try {
    result = run();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
}

const succeed = <T,>(value: T) => (cb: (r: { status: string; value: T }) => void) => cb({ status: "succeeded", value });

function readItemStub(overrides: Partial<{ itemId: string; subject: string; body: string }> = {}) {
  const { itemId = "item-1", subject = "A subject", body = "A body" } = overrides;
  return {
    itemId,
    subject,
    conversationId: "conv-1",
    from: { displayName: "Dana", emailAddress: "dana@atlas-partners.example" },
    to: [],
    cc: [],
    dateTimeCreated: new Date("2026-09-15T07:24:00.000Z"),
    attachments: [],
    body: { getAsync: (_type: unknown, cb: (r: { status: string; value: string }) => void) => succeed(body)(cb) },
    categories: { getAsync: succeed([]) },
  };
}

const officeWith = (item: unknown, extra: Record<string, unknown> = {}) => ({
  context: {
    mailbox: { item, userProfile: { displayName: "Alex", emailAddress: "alex@northbridge.example" }, ...extra },
    requirements: { isSetSupported: () => true },
  },
  CoercionType: { Text: "text" },
  AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
  MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
});

/* ------------------------------------------------------------------ */

describe("the host's current item is the key of everything item-bound", () => {
  it("reads the id and the subject of whatever the host holds right now", () => {
    withOffice(officeWith(readItemStub({ itemId: "id-B", subject: "TR : Atlas" })), () => {
      expect(currentItemId()).toBe("id-B");
      expect(currentItemSubject()).toBe("TR : Atlas");
    });
  });

  it("reports no item (rather than throwing) when the message was closed", async () => {
    await withOffice(officeWith(null), async () => {
      expect(currentItemId()).toBe("");
      expect(currentItemSubject()).toBe("");
      await expect(readCurrentItem()).rejects.toBeInstanceOf(NoItemError);
    });
  });

  it("falls back to the preview sample outside Outlook", () => {
    withOffice(undefined, () => {
      expect(currentItemId()).toBe(sampleEmail.id);
      expect(currentItemSubject()).toBe(sampleEmail.subject);
    });
  });
});

describe("useAsync drops a value that describes another key", () => {
  it("clears data in the same render as the key change, before anything is painted", async () => {
    const loader = vi.fn(async (id: string) => `value-for-${id}`);
    const { result, rerender } = renderHook(({ id }: { id: string }) => useAsync(() => loader(id), [id]), {
      initialProps: { id: "A" },
    });
    await waitFor(() => expect(result.current.data).toBe("value-for-A"));

    rerender({ id: "B" });
    // No "value-for-A" while B loads: this is the stale-pane bug.
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toBe("value-for-B"));
  });

  it("ignores a promise that resolves after the key changed", async () => {
    let releaseA: (v: string) => void = () => undefined;
    const loader = (id: string) =>
      id === "A" ? new Promise<string>((resolve) => (releaseA = resolve)) : Promise.resolve(`value-for-${id}`);

    const { result, rerender } = renderHook(({ id }: { id: string }) => useAsync(() => loader(id), [id]), {
      initialProps: { id: "A" },
    });
    rerender({ id: "B" });
    await waitFor(() => expect(result.current.data).toBe("value-for-B"));
    await act(async () => {
      releaseA("value-for-A");
    });
    expect(result.current.data).toBe("value-for-B");
  });
});

describe("useAnalysis is keyed by (item, content, language)", () => {
  function stubApi() {
    const analysisByEmail = vi.fn<(id: string) => Promise<EmailAnalysis | null>>().mockResolvedValue(null);
    const analyzeEmail = vi.fn(async (req: { email: EmailContext }, opts?: { signal?: AbortSignal }) => {
      await new Promise((r) => setTimeout(r, 5));
      if (opts?.signal?.aborted) throw new Error("aborted");
      return { ...mockAnalysis("en", req.email.id), source: "llm" as const, summary: `analysis of ${req.email.id}` };
    });
    return { mode: "mock", analysisByEmail, analyzeEmail } as unknown as OaoApi & { analyzeEmail: typeof analyzeEmail };
  }

  beforeEach(() => setCacheStore(memoryStore()));

  it("drops the previous analysis in the render that sees the new email", async () => {
    const api = stubApi();
    const { result, rerender } = renderHook(({ email }: { email: EmailContext }) => useAnalysis({ api, email, lang: "en", stableIdOf: (id) => id }), {
      initialProps: { email: sampleEmail },
    });
    await waitFor(() => expect(result.current.data?.summary).toBe(`analysis of ${sampleEmail.id}`));

    rerender({ email: sampleNewsletter });
    expect(result.current.data).toBeNull();
    expect(result.current.source).toBeUndefined();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data?.summary).toBe(`analysis of ${sampleNewsletter.id}`));
  });

  it("aborts the request of an email the user has left", async () => {
    const api = stubApi();
    const { result, rerender } = renderHook(({ email }: { email: EmailContext }) => useAnalysis({ api, email, lang: "en", stableIdOf: (id) => id }), {
      initialProps: { email: sampleEmail },
    });
    await waitFor(() => expect(api.analyzeEmail).toHaveBeenCalledTimes(1));
    const firstSignal = api.analyzeEmail.mock.calls[0]![1]!.signal!;
    expect(firstSignal.aborted).toBe(false);

    rerender({ email: sampleNewsletter });
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.data?.summary).toBe(`analysis of ${sampleNewsletter.id}`));
  });

  it("aborts on unmount so a model call cannot outlive the pane", async () => {
    const api = stubApi();
    const { unmount } = renderHook(() => useAnalysis({ api, email: sampleEmail, lang: "en", stableIdOf: (id) => id }));
    await waitFor(() => expect(api.analyzeEmail).toHaveBeenCalledTimes(1));
    const signal = api.analyzeEmail.mock.calls[0]![1]!.signal!;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("the difference between 'rules were enough' and 'the AI is down'", () => {
  const base = mockAnalysis("en", "id");

  it("recognises a degraded analysis by its risk code", () => {
    expect(isDegraded(base)).toBe(false);
    expect(
      isDegraded({ ...base, source: "heuristic", risks: [...base.risks, { code: DEGRADED_RISK_CODE, title: "Degraded", severity: "medium" }] }),
    ).toBe(true);
  });

  it("recognises an analysis with nothing in it", () => {
    expect(isEmptyAnalysis(base)).toBe(false);
    expect(isEmptyAnalysis({ ...base, summary: "   ", decisions: [], pendingTasks: [], risks: [] })).toBe(true);
    // A blank summary with content elsewhere is not "empty": it still says something.
    expect(isEmptyAnalysis({ ...base, summary: "", decisions: ["Signed off"], pendingTasks: [], risks: [] })).toBe(false);
  });
});

describe("plain-text reduction keeps mail addresses", () => {
  it("does not treat <address@host> as markup", () => {
    const forwarded = 'De : Comptabilité Atlas <compta@atlas-partners.example>\nObjet : Atlas — relevé à valider';
    expect(looksLikeHtml(forwarded)).toBe(false);
    expect(toPlainText(forwarded)).toContain("compta@atlas-partners.example");
    // The summary of a forward used to be emptied completely by this.
    expect(toPlainText("<compta@atlas-partners.example>")).toBe("<compta@atlas-partners.example>");
  });

  it("still removes real markup", () => {
    expect(toPlainText("<p>Hello <b>world</b></p>")).toBe("Hello world");
    expect(toPlainText('<script>alert("x")</script>safe')).toBe("safe");
    expect(toPlainText("<img src=x onerror=alert(1)>text")).toBe("text");
  });
});

describe("the local caches are scoped to the mailbox", () => {
  it("gives two accounts different keys for the same email and the same day", () => {
    let a = "";
    let b = "";
    withOffice(officeWith(null, { userProfile: { displayName: "A", emailAddress: "a@northbridge.example" } }), () => {
      a = cacheKey("brief", "2026-09-16:fr", "v1");
    });
    withOffice(officeWith(null, { userProfile: { displayName: "B", emailAddress: "b@northbridge.example" } }), () => {
      b = cacheKey("brief", "2026-09-16:fr", "v1");
    });
    expect(a).not.toBe(b);
    expect(a.startsWith("brief:")).toBe(true);
  });

  it("keeps the per-session message cache of two accounts apart", async () => {
    const { cacheItem, loadRecentFromCache } = await import("@/office/cache");
    const email: EmailContext = { ...sampleEmail, id: "shared-id" };

    withOffice(officeWith(null, { userProfile: { displayName: "A", emailAddress: "a@northbridge.example" } }), () => {
      cacheItem(email);
      expect(loadRecentFromCache().map((e) => e.id)).toContain("shared-id");
    });
    withOffice(officeWith(null, { userProfile: { displayName: "B", emailAddress: "b@northbridge.example" } }), () => {
      // Another mailbox must not see the first one's message bodies.
      expect(loadRecentFromCache().map((e) => e.id)).not.toContain("shared-id");
    });
  });
});

describe("compose: the draft's classification label", () => {
  it("is read from the item and resolved to its display name", async () => {
    const composeItem = {
      itemId: "draft-1",
      to: { getAsync: succeed([{ displayName: "Ops", emailAddress: "operations@northbridge.example" }]) },
      cc: { getAsync: succeed([]) },
      bcc: { getAsync: succeed([]) },
      subject: { getAsync: succeed("Atlas cutover") },
      body: { getAsync: (_t: unknown, cb: (r: { status: string; value: string }) => void) => succeed("Hello")(cb) },
      from: { getAsync: succeed({ displayName: "Alex", emailAddress: "alex@northbridge.example" }) },
      getAttachmentsAsync: succeed([]),
      sensitivityLabel: { getAsync: succeed("lbl-internal") },
    };
    const office = officeWith(composeItem);
    (office.context as unknown as { sensitivityLabelsCatalog: unknown }).sensitivityLabelsCatalog = {
      getAsync: succeed([
        { id: "lbl-internal", name: "Internal" },
        { id: "lbl-confidential", name: "Confidential" },
      ]),
    };

    await withOffice(office, async () => {
      const draft = await readCompose();
      expect(draft.sensitivityLabel).toBe("Internal");
      expect(draft.subject).toBe("Atlas cutover");
    });
  });

  it("is undefined (not a crash) on a host without the label API", async () => {
    const composeItem = {
      itemId: "draft-2",
      to: { getAsync: succeed([]) },
      cc: { getAsync: succeed([]) },
      bcc: { getAsync: succeed([]) },
      subject: { getAsync: succeed("No label here") },
      body: { getAsync: (_t: unknown, cb: (r: { status: string; value: string }) => void) => succeed("Hello")(cb) },
      getAttachmentsAsync: succeed([]),
    };
    await withOffice(officeWith(composeItem), async () => {
      const draft = await readCompose();
      expect(draft.sensitivityLabel).toBeUndefined();
    });
  });
});

afterEach(() => vi.restoreAllMocks());

/* The one component-level check: the read surface names its email. */
describe("the read surface always says which email it is about", () => {
  it("renders the subject of the item the host holds", async () => {
    const { ReadMode } = await import("@/app/ReadMode");
    const { renderWithProviders } = await import("./render");
    const office = officeWith(readItemStub({ itemId: "id-A", subject: "Atlas — open points" }));

    await withOffice(office, async () => {
      renderWithProviders(<ReadMode itemId="id-A" />);
      await waitFor(() => expect(document.querySelector('[data-testid="item-subject"]')?.textContent).toBe("Atlas — open points"));
    });
  });
});

/**
 * The three new ways into the pane:
 *   - host detection (tab/home vs read vs compose vs preview),
 *   - the multi-select selection (hashing, `loadItemByIdAsync` fallbacks),
 *   - the `ItemChanged` / `SelectedItemsChanged` handler lifecycle, which must
 *     add exactly one Office handler and remove it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideApi } from "@/api";
import { hostSurface, isPreviewMode, isTabHost } from "@/office/env";
import { detectSurfaceSync, resolveSurface } from "@/office/host";
import { addMailboxListener, isMailboxEventSupported, mailboxListenerCount, resetMailboxListeners } from "@/office/events";
import {
  EMPTY_SELECTION,
  isItemLoadSupported,
  isMultiSelectSupported,
  previewSelectionSize,
  readSelectedItems,
  selectionEmailsForIndex,
  selectionId,
  selectionThread,
  SELECTION_PREFIX,
} from "@/office/selection";

/* ------------------------------------------------------------- test doubles */

const originalOffice = (globalThis as { Office?: unknown }).Office;

function setOffice(stub: unknown): void {
  Object.defineProperty(globalThis, "Office", { value: stub, configurable: true, writable: true });
}

function setUrl(search: string): void {
  window.history.replaceState({}, "", `/taskpane.html${search}`);
}

/** Minimal Office stub: a mailbox with the requirement sets listed in `sets`. */
function officeStub(options: {
  mailbox?: Record<string, unknown> | null;
  sets?: string[];
  context?: Record<string, unknown>;
} = {}) {
  const sets = new Set(options.sets ?? []);
  return {
    EventType: { ItemChanged: "olkItemChanged", SelectedItemsChanged: "olkSelectedItemsChanged" },
    CoercionType: { Text: "text" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    context: {
      requirements: { isSetSupported: (name: string, version: string) => name === "Mailbox" && sets.has(version) },
      ...(options.mailbox === null ? {} : { mailbox: options.mailbox ?? {} }),
      ...options.context,
    },
  };
}

const ok = <T>(value: T) => ({ status: "succeeded", value }) as unknown as Office.AsyncResult<T>;
const failed = { status: "failed", error: { message: "nope" } } as unknown as Office.AsyncResult<never>;

beforeEach(() => {
  setUrl("");
  resetMailboxListeners();
});

afterEach(() => {
  setOffice(originalOffice);
  setUrl("");
  resetMailboxListeners();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------ host detection */

describe("host detection", () => {
  it("is browser preview when there is no Office host at all", () => {
    setOffice(undefined);
    expect(hostSurface()).toBe("browser");
    expect(isTabHost()).toBe(false);
    expect(isPreviewMode()).toBe(true);
    expect(detectSurfaceSync()).toBe("read"); // preview always has the sample email
  });

  it("treats ?host=tab as the Apps-rail personal tab: home mode, real backend", () => {
    setOffice(undefined);
    setUrl("?view=home&host=tab");
    expect(isTabHost()).toBe(true);
    expect(hostSurface()).toBe("tab");
    expect(isPreviewMode()).toBe(false); // no sample email, no "Preview mode" pill
    expect(detectSurfaceSync()).toBe("home");
  });

  it("treats ?view=home alone as home mode too (browser against the real backend)", () => {
    setOffice(undefined);
    setUrl("?view=home");
    expect(isPreviewMode()).toBe(false);
    expect(detectSurfaceSync()).toBe("home");
  });

  it("treats an Office host without a mailbox as the tab surface", () => {
    setOffice(officeStub({ mailbox: null, context: { host: "Outlook", platform: "OfficeOnline" } }));
    expect(isTabHost()).toBe(true);
    expect(hostSurface()).toBe("tab");
    expect(isPreviewMode()).toBe(false);
    expect(detectSurfaceSync()).toBe("home");
  });

  it("stays in browser preview when office.js loaded but reports no host at all", () => {
    // office.js fetched from the CDN in a plain browser: a context exists, but
    // `host` / `platform` are null — that is dev preview, not the tab surface.
    setOffice({ context: { host: null, platform: null }, onReady: () => undefined });
    expect(isTabHost()).toBe(false);
    expect(hostSurface()).toBe("browser");
    expect(isPreviewMode()).toBe(true);
    expect(detectSurfaceSync()).toBe("read");
  });

  it("keeps ?preview=1 as the escape hatch for browser dev", () => {
    setOffice(officeStub({ mailbox: { item: {} }, sets: ["1.5"] }));
    setUrl("?preview=1");
    expect(isPreviewMode()).toBe(true);
  });

  it("detects compose from the query string and from a compose item", () => {
    setOffice(undefined);
    setUrl("?mode=compose");
    expect(detectSurfaceSync()).toBe("compose");
    setUrl("");
    setOffice(officeStub({ mailbox: { item: { subject: { getAsync: () => undefined } } } }));
    expect(detectSurfaceSync()).toBe("compose");
  });

  it("renders the read pane for one selected item and the brief/chat home for none", () => {
    setOffice(officeStub({ mailbox: { item: { itemId: "x", subject: "plain string" } } }));
    expect(detectSurfaceSync()).toBe("read");
    // Pinned pane, nothing selected (SupportsNoItemContext) → home, not an
    // apologetic "select an email".
    setOffice(officeStub({ mailbox: {} }));
    expect(detectSurfaceSync()).toBe("home");
  });

  it("uses ?view=brief even when an item is open", () => {
    setOffice(officeStub({ mailbox: { item: { itemId: "x", subject: "s" } } }));
    setUrl("?view=brief");
    expect(detectSurfaceSync()).toBe("brief");
  });

  it("fakes a selection in preview with ?selection=N (and ignores N < 2)", () => {
    setOffice(undefined);
    setUrl("?preview=1&selection=3");
    expect(previewSelectionSize()).toBe(3);
    expect(detectSurfaceSync()).toBe("selection");
    setUrl("?preview=1&selection=1");
    expect(previewSelectionSize()).toBe(0);
    expect(detectSurfaceSync()).toBe("read");
  });
});

describe("resolveSurface", () => {
  it("promotes 'nothing selected' to the selection view when several items are selected", async () => {
    setOffice(
      officeStub({
        sets: ["1.13"],
        mailbox: { getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok([{ itemId: "a" }, { itemId: "b" }, { itemId: "c" }])) },
      }),
    );
    expect(detectSurfaceSync()).toBe("home");
    await expect(resolveSurface()).resolves.toBe("selection");
  });

  it("stays on the home surface for zero or one selected item, and when the host cannot tell", async () => {
    setOffice(officeStub({ sets: ["1.13"], mailbox: { getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok([{ itemId: "a" }])) } }));
    await expect(resolveSurface()).resolves.toBe("home");
    setOffice(officeStub({ mailbox: {} })); // no 1.13 → no getSelectedItemsAsync
    await expect(resolveSurface()).resolves.toBe("home");
  });

  it("never overrides an explicit surface", async () => {
    setOffice(officeStub({ sets: ["1.13"], mailbox: { getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok([{ itemId: "a" }, { itemId: "b" }])) } }));
    setUrl("?view=brief");
    await expect(resolveSurface()).resolves.toBe("brief");
    setUrl("?view=home");
    await expect(resolveSurface()).resolves.toBe("home"); // the ribbon asked for the home surface
    setUrl("");
    await expect(resolveSurface("read")).resolves.toBe("read");
    await expect(resolveSurface("compose")).resolves.toBe("compose");
  });
});

/* --------------------------------------------------------- selection hashing */

describe("selection hashing", () => {
  it("is stable and independent of the selection order", () => {
    const a = selectionId(["id-1", "id-2", "id-3"]);
    expect(a).toBe(selectionId(["id-3", "id-1", "id-2"]));
    expect(a.startsWith(SELECTION_PREFIX)).toBe(true);
  });

  it("ignores duplicates, blanks and surrounding whitespace", () => {
    expect(selectionId(["a", "a", "", "  ", " b "])).toBe(selectionId(["b", "a"]));
  });

  it("changes when the set changes", () => {
    expect(selectionId(["a", "b"])).not.toBe(selectionId(["a", "b", "c"]));
    expect(selectionId(["a", "b"])).not.toBe(selectionId(["a", "c"]));
  });

  it("builds a ThreadContext keyed by the selection id and re-keys the indexed copies", () => {
    setOffice(undefined);
    setUrl("?preview=1&selection=3");
    const selection = { id: selectionId(["a", "b"]), items: [], loadedCount: 0, degraded: false, supported: true };
    expect(selectionThread(selection, "2 selected emails")).toBeNull();

    const withItems = {
      ...selection,
      items: [
        { id: "a", conversationId: "conv-1", subject: "A", to: [], cc: [], bcc: [], body: "body a", attachments: [], categories: [] },
        { id: "b", conversationId: "conv-2", subject: "B", to: [], cc: [], bcc: [], body: "body b", attachments: [], categories: [] },
      ],
    };
    const thread = selectionThread(withItems, "2 selected emails");
    expect(thread?.conversationId).toBe(selection.id);
    expect(thread?.messages).toHaveLength(2);
    // The chat scope is `selection:<hash>`, so the indexed copies must carry it.
    expect(selectionEmailsForIndex(withItems).map((e) => e.conversationId)).toEqual([selection.id, selection.id]);
  });
});

/* ------------------------------------------------------- multi-select paths */

describe("reading the selection", () => {
  it("reports 'unsupported' instead of throwing on a host without Mailbox 1.13", async () => {
    setOffice(officeStub({ mailbox: {} }));
    expect(isMultiSelectSupported()).toBe(false);
    await expect(readSelectedItems()).resolves.toEqual({ ...EMPTY_SELECTION, supported: false });
  });

  it("loads every selected item in full when loadItemByIdAsync is available", async () => {
    const loadItemByIdAsync = vi.fn((id: string, cb: (r: unknown) => void) =>
      cb(
        ok({
          itemId: id,
          subject: `Subject ${id}`,
          from: { displayName: "Sender", emailAddress: "sender@example.test" },
          to: [],
          cc: [],
          attachments: [],
          dateTimeCreated: "2025-05-25T07:24:00.000Z",
          conversationId: `conv-${id}`,
          internetMessageId: `<${id}@example.test>`,
          body: { getAsync: (_type: unknown, bodyCb: (r: unknown) => void) => bodyCb(ok(`body of ${id}`)) },
        }),
      ),
    );
    setOffice(
      officeStub({
        sets: ["1.13", "1.15"],
        mailbox: {
          getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok([{ itemId: "a", subject: "A" }, { itemId: "b", subject: "B" }])),
          loadItemByIdAsync,
        },
      }),
    );
    expect(isItemLoadSupported()).toBe(true);

    const selection = await readSelectedItems();
    expect(selection.supported).toBe(true);
    expect(selection.degraded).toBe(false);
    expect(selection.loadedCount).toBe(2);
    expect(selection.id).toBe(selectionId(["a", "b"]));
    expect(selection.items.map((i) => i.body)).toEqual(["body of a", "body of b"]);
    expect(selection.items[0]!.from?.address).toBe("sender@example.test");
    expect(loadItemByIdAsync).toHaveBeenCalledTimes(2);
  });

  it("falls back to subject-only items when loadItemByIdAsync is missing", async () => {
    setOffice(
      officeStub({
        sets: ["1.13"], // no 1.15
        mailbox: {
          getSelectedItemsAsync: (cb: (r: unknown) => void) =>
            cb(ok([{ itemId: "a", subject: "A", conversationId: "conv-a" }, { itemId: "b", subject: "B" }])),
        },
      }),
    );
    const selection = await readSelectedItems();
    expect(selection.supported).toBe(true);
    expect(selection.degraded).toBe(true);
    expect(selection.loadedCount).toBe(0);
    expect(selection.items).toHaveLength(2);
    expect(selection.items[0]).toMatchObject({ id: "a", subject: "A", conversationId: "conv-a", body: "" });
    expect(selection.items[0]!.from).toBeUndefined();
  });

  it("degrades per item: one unreadable message does not sink the selection", async () => {
    setOffice(
      officeStub({
        sets: ["1.13", "1.15"],
        mailbox: {
          getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok([{ itemId: "a", subject: "A" }, { itemId: "b", subject: "B" }])),
          loadItemByIdAsync: (id: string, cb: (r: unknown) => void) =>
            id === "a"
              ? cb(ok({ itemId: "a", subject: "Full A", to: [], cc: [], attachments: [], body: { getAsync: (_t: unknown, b: (r: unknown) => void) => b(ok("body a")) } }))
              : cb(failed),
        },
      }),
    );
    const selection = await readSelectedItems();
    expect(selection.loadedCount).toBe(1);
    expect(selection.degraded).toBe(true);
    expect(selection.items.map((i) => i.subject)).toEqual(["Full A", "B"]);
  });

  it("reports 'unsupported' when getSelectedItemsAsync itself fails", async () => {
    setOffice(officeStub({ sets: ["1.13"], mailbox: { getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(failed) } }));
    const selection = await readSelectedItems();
    expect(selection.supported).toBe(false);
  });

  it("serves a fake selection in browser preview", async () => {
    setOffice(undefined);
    setUrl("?preview=1&selection=3");
    const selection = await readSelectedItems();
    expect(selection.supported).toBe(true);
    expect(selection.items).toHaveLength(3);
    expect(selection.degraded).toBe(false);
    expect(new Set(selection.items.map((i) => i.id)).size).toBe(3);
  });
});

/* ------------------------------------------------------- handler lifecycle */

describe("mailbox event handler lifecycle", () => {
  function eventOffice() {
    const addHandlerAsync = vi.fn((_type: unknown, _handler: () => void, cb: (r: unknown) => void) => cb(ok(undefined)));
    const removeHandlerAsync = vi.fn((_type: unknown, cb: (r: unknown) => void) => cb(ok(undefined)));
    setOffice(officeStub({ sets: ["1.5", "1.13"], mailbox: { addHandlerAsync, removeHandlerAsync } }));
    return { addHandlerAsync, removeHandlerAsync };
  }

  it("adds one Office handler for many listeners and removes it once", async () => {
    const { addHandlerAsync, removeHandlerAsync } = eventOffice();
    expect(isMailboxEventSupported("ItemChanged")).toBe(true);

    const a = vi.fn();
    const b = vi.fn();
    const offA = addMailboxListener("ItemChanged", a);
    const offB = addMailboxListener("ItemChanged", b);
    expect(addHandlerAsync).toHaveBeenCalledTimes(1);
    expect(mailboxListenerCount("ItemChanged")).toBe(2);

    // The Office handler fans out to both listeners.
    addHandlerAsync.mock.calls[0]![1]!();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    expect(removeHandlerAsync).not.toHaveBeenCalled(); // b is still listening
    offB();
    expect(removeHandlerAsync).toHaveBeenCalledTimes(1);
    expect(mailboxListenerCount("ItemChanged")).toBe(0);

    // Unsubscribing twice (React StrictMode) must not remove anything again.
    offB();
    expect(removeHandlerAsync).toHaveBeenCalledTimes(1);
  });

  it("re-registers after the last listener left, and keeps the two event types apart", () => {
    const { addHandlerAsync, removeHandlerAsync } = eventOffice();
    addMailboxListener("ItemChanged", vi.fn())();
    expect(addHandlerAsync).toHaveBeenCalledTimes(1);
    expect(removeHandlerAsync).toHaveBeenCalledTimes(1);

    addMailboxListener("ItemChanged", vi.fn());
    addMailboxListener("SelectedItemsChanged", vi.fn());
    expect(addHandlerAsync).toHaveBeenCalledTimes(3);
    expect(addHandlerAsync.mock.calls.map((c) => c[0])).toEqual(["olkItemChanged", "olkItemChanged", "olkSelectedItemsChanged"]);
  });

  it("a throwing listener does not stop the others", () => {
    const { addHandlerAsync } = eventOffice();
    const boom = vi.fn(() => {
      throw new Error("boom");
    });
    const fine = vi.fn();
    addMailboxListener("ItemChanged", boom);
    addMailboxListener("ItemChanged", fine);
    expect(() => addHandlerAsync.mock.calls[0]![1]!()).not.toThrow();
    expect(fine).toHaveBeenCalledTimes(1);
  });

  it("is a silent no-op on a host without the requirement set", () => {
    const addHandlerAsync = vi.fn();
    setOffice(officeStub({ sets: ["1.10"], mailbox: { addHandlerAsync } }));
    expect(isMailboxEventSupported("SelectedItemsChanged")).toBe(false);
    const off = addMailboxListener("SelectedItemsChanged", vi.fn());
    expect(addHandlerAsync).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });

  it("is a silent no-op in browser preview (no Office at all)", () => {
    setOffice(undefined);
    const off = addMailboxListener("ItemChanged", vi.fn());
    expect(mailboxListenerCount("ItemChanged")).toBe(1);
    expect(() => off()).not.toThrow();
  });
});

/* ------------------------------------------------------- live vs mock API */

describe("live vs mock decision", () => {
  it("uses the mock only when it was explicitly requested", () => {
    for (const preview of [true, false]) {
      for (const healthOk of [true, false]) {
        expect(decideApi({ mockRequested: true, preview, healthOk })).toEqual({ api: "mock", reason: "requested", blocking: false });
      }
    }
  });

  it("stays live when the backend answers", () => {
    expect(decideApi({ mockRequested: false, preview: false, healthOk: true })).toEqual({ api: "live", reason: "live", blocking: false });
    expect(decideApi({ mockRequested: false, preview: true, healthOk: true })).toEqual({ api: "live", reason: "live", blocking: false });
  });

  it("falls back to the mock only in browser preview, where there is no real mailbox", () => {
    expect(decideApi({ mockRequested: false, preview: true, healthOk: false })).toEqual({ api: "mock", reason: "preview-fallback", blocking: false });
  });

  it("never shows sample data inside an Outlook host: it blocks instead", () => {
    // read / compose / pinned / multi-select / Apps-rail home all land here.
    expect(decideApi({ mockRequested: false, preview: false, healthOk: false })).toEqual({ api: "live", reason: "live-unreachable", blocking: true });
  });

  it("matches the host detection it depends on: the tab surface is not preview", () => {
    setOffice(undefined);
    setUrl("?view=home&host=tab");
    expect(isPreviewMode()).toBe(false);
    expect(decideApi({ mockRequested: false, preview: isPreviewMode(), healthOk: false }).blocking).toBe(true);

    setUrl("");
    expect(isPreviewMode()).toBe(true);
    expect(decideApi({ mockRequested: false, preview: isPreviewMode(), healthOk: false }).api).toBe("mock");
  });
});

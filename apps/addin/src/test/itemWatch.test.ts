/**
 * "I switch email with the pane open and it keeps the previous one."
 *
 * A host that neither raises `ItemChanged` nor swaps `mailbox.item` (the
 * Office.js bugs the pane has to survive) is modelled here: only the list
 * selection (`getSelectedItemsAsync`) moves. The watcher must notice the
 * change, point the pane at the selected message and load it by id — then let
 * go as soon as Outlook's own item catches up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { designatedItem, isDockedPane, newSelectionWatch, pollHostSelection, selectionKey } from "@/office/itemWatch";
import { currentConversationId, currentItemId, currentItemSubject, hasSelectedItemOverride, loadMessageById, normalizeItemId, readCurrentItem, sameItemId, setSelectedItemOverride } from "@/office/readItem";

const originalOffice = (globalThis as { Office?: unknown }).Office;
const ok = <T>(value: T) => ({ status: "succeeded", value });

interface Msg {
  itemId: string;
  conversationId: string;
  subject: string;
  body: string;
}
const A: Msg = { itemId: "AAMkAD+a/1=", conversationId: "conv-a", subject: "Email A", body: "Body of A" };
const B: Msg = { itemId: "AAMkAD+b/2=", conversationId: "conv-b", subject: "Email B", body: "Body of B" };
const B2: Msg = { itemId: "AAMkAD+b/3=", conversationId: "conv-b", subject: "RE: Email B", body: "Reply in B" };

function readItem(m: Msg) {
  return {
    itemId: m.itemId,
    conversationId: m.conversationId,
    subject: m.subject,
    from: { displayName: "Sender", emailAddress: "sender@example.com" },
    to: [],
    cc: [],
    attachments: [],
    dateTimeCreated: new Date("2026-09-20T08:00:00Z"),
    body: { getAsync: (_t: unknown, cb: (r: unknown) => void) => cb(ok(m.body)) },
  };
}

/** A host whose `mailbox.item` is stuck on `stuck` while the list selection is `selected`. */
function brokenHost(stuck: Msg, sets = ["1.5", "1.13", "1.15"]) {
  const state = { item: readItem(stuck) as ReturnType<typeof readItem> | null, selected: [stuck], loads: [] as string[], unloads: 0, loaded: 0 };
  const mailbox = {
    get item() {
      return state.item;
    },
    getSelectedItemsAsync: (cb: (r: unknown) => void) => cb(ok(state.selected.map((m) => ({ itemId: m.itemId, conversationId: m.conversationId, subject: m.subject, itemType: "message", itemMode: "read" })))),
    loadItemByIdAsync: (id: string, cb: (r: unknown) => void) => {
      // Outlook allows a single loaded item at a time.
      if (state.loaded > 0) return cb({ status: "failed", error: { message: "unload the previous item first" } });
      const m = [A, B, B2].find((x) => sameItemId(x.itemId, id));
      state.loads.push(id);
      if (!m) return cb({ status: "failed", error: { message: "not found" } });
      state.loaded++;
      cb(ok({ ...readItem(m), unloadAsync: (u: (r: unknown) => void) => ((state.loaded--, state.unloads++), u(ok(undefined))) }));
    },
  };
  const office = {
    EventType: { ItemChanged: "olkItemChanged", SelectedItemsChanged: "olkSelectedItemsChanged" },
    CoercionType: { Text: "text" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    context: { requirements: { isSetSupported: (name: string, v: string) => name === "Mailbox" && sets.includes(v) }, mailbox },
  };
  Object.defineProperty(globalThis, "Office", { value: office, configurable: true, writable: true });
  return state;
}

const rendered = () => ({ itemId: currentItemId(), conversationId: currentConversationId() });

beforeEach(() => setSelectedItemOverride(null));
afterEach(() => {
  setSelectedItemOverride(null);
  Object.defineProperty(globalThis, "Office", { value: originalOffice, configurable: true, writable: true });
  vi.restoreAllMocks();
});

describe("item ids", () => {
  it("compares base64 and base64url forms of the same EWS id", () => {
    expect(normalizeItemId("AAMk-_x==")).toBe("AAMk+/x");
    expect(sameItemId("AAMk+/x=", "AAMk-_x")).toBe(true);
    expect(sameItemId("", "")).toBe(false);
  });
});

describe("list selection → designated message", () => {
  it("one message, a whole conversation, or nothing for a real multi-selection", () => {
    brokenHost(A);
    const ref = (m: Msg) => ({ itemId: m.itemId, conversationId: m.conversationId, subject: m.subject });
    expect(designatedItem([ref(B)])?.itemId).toBe(B.itemId);
    expect(designatedItem([ref(B), ref(B2)])?.itemId).toBe(B.itemId); // collapsed conversation in OWA
    expect(designatedItem([ref(A), ref(B)])).toBeNull(); // real multi-select: the selection view's job
    expect(designatedItem([])).toBeNull();
    expect(selectionKey([ref(B), ref(A)])).toBe(selectionKey([ref(A), ref(B)]));
  });
});

describe("pollHostSelection", () => {
  it("follows the list when neither ItemChanged nor mailbox.item moved, loads the message by id and unloads it", async () => {
    const host = brokenHost(A);
    const watch = newSelectionWatch();
    expect(await pollHostSelection(watch, rendered())).toBe(false); // baseline
    expect(await pollHostSelection(watch, rendered())).toBe(false); // nothing moved

    host.selected = [B]; // the user clicks B; Outlook tells the pane nothing
    expect(await pollHostSelection(watch, rendered())).toBe(true);
    expect(currentItemId()).toBe(B.itemId);
    expect(currentItemSubject()).toBe("Email B");
    expect(currentConversationId()).toBe("conv-b");
    const email = await readCurrentItem();
    expect(email).toMatchObject({ id: B.itemId, subject: "Email B", body: "Body of B" });
    expect(host.unloads).toBe(1);
    expect(await pollHostSelection(watch, rendered())).toBe(false); // stable

    // Outlook finally swaps its own item: the override lets go.
    host.item = readItem(B2);
    expect(hasSelectedItemOverride()).toBe(false);
    expect(currentItemId()).toBe(B2.itemId);
  });

  it("only re-reads when mailbox.item did move but the event was lost", async () => {
    const host = brokenHost(A);
    const watch = newSelectionWatch();
    await pollHostSelection(watch, rendered());
    host.item = readItem(B);
    host.selected = [B];
    // `rendered` is still A: the pane never heard of the switch.
    expect(await pollHostSelection(watch, { itemId: A.itemId, conversationId: A.conversationId })).toBe(true);
    expect(hasSelectedItemOverride()).toBe(false);
    expect(currentItemId()).toBe(B.itemId);
  });

  it("does not replace a message opened inside the conversation on screen", async () => {
    const host = brokenHost(B);
    const watch = newSelectionWatch();
    await pollHostSelection(watch, rendered());
    // The whole conversation gets selected in the list; the reading pane shows it.
    host.selected = [B2, B];
    expect(await pollHostSelection(watch, rendered())).toBe(false);
    expect(currentItemId()).toBe(B.itemId);
  });

  it("does nothing when the list did not change, even if it differs from the pane", async () => {
    const host = brokenHost(B2);
    host.selected = [B]; // list and pane disagree from the start (message opened from the conversation)
    const watch = newSelectionWatch();
    expect(await pollHostSelection(watch, rendered())).toBe(false);
    expect(await pollHostSelection(watch, rendered())).toBe(false);
    expect(currentItemId()).toBe(B2.itemId);
  });

  it("stays out of a real multi-selection and of hosts without getSelectedItemsAsync", async () => {
    const host = brokenHost(A);
    const watch = newSelectionWatch();
    await pollHostSelection(watch, rendered());
    host.selected = [A, B];
    expect(await pollHostSelection(watch, rendered())).toBe(false);

    brokenHost(A, ["1.5"]);
    const w2 = newSelectionWatch();
    expect(await pollHostSelection(w2, rendered())).toBe(false);
    expect(await pollHostSelection(w2, rendered())).toBe(false);
  });

  it("is disabled in a popped-out message window", async () => {
    const host = brokenHost(A);
    const top = window.top as Window & { opener: unknown };
    const spy = vi.spyOn(window, "top", "get").mockReturnValue({ ...top, opener: {} } as unknown as Window);
    expect(isDockedPane()).toBe(false);
    const watch = newSelectionWatch();
    await pollHostSelection(watch, rendered());
    host.selected = [B];
    expect(await pollHostSelection(watch, rendered())).toBe(false);
    spy.mockRestore();
    expect(isDockedPane()).toBe(true);
  });
});

describe("loadMessageById", () => {
  it("serialises loads so each one is unloaded before the next (Outlook allows one at a time)", async () => {
    const host = brokenHost(A);
    const [b, b2, missing] = await Promise.all([loadMessageById(B.itemId), loadMessageById(B2.itemId), loadMessageById("nope")]);
    expect(b?.subject).toBe("Email B");
    expect(b2?.subject).toBe("RE: Email B");
    expect(missing).toBeNull();
    expect(host.unloads).toBe(2);
    expect(host.loaded).toBe(0);
  });

  it("an override that cannot be loaded never falls back to the stale host item", async () => {
    brokenHost(A);
    setSelectedItemOverride({ itemId: "unknown-id", subject: "Gone" });
    await expect(readCurrentItem()).rejects.toMatchObject({ name: "NoItemError" });
  });
});

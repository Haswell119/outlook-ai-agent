/**
 * "All emails" in the chat — what it can search and how it says so.
 *
 * Without Microsoft Graph the index only holds the emails this browser has
 * shown the orchestrator. The tab must (1) say how many emails the question
 * can reach, (2) index the browsed emails it has not sent yet before a
 * mailbox-wide question, once, and (3) report per answer how many indexed
 * emails matched — so a user is never left guessing why the assistant "sticks
 * to the last email".
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/api/mock";
import { mockSyncStatus } from "@/api/mockBrief";
import { ChatTab } from "@/features/chat/ChatTab";
import { cacheItem, clearCache } from "@/office/cache";
import { clearIndexed, isIndexed, markIndexed, notYetIndexed } from "@/office/indexed";
import { sampleEmail } from "@/office/sample";
import { renderWithProviders } from "./render";

function apiWith(status: ReturnType<typeof mockSyncStatus>) {
  const base = createMockClient(() => "en", 0);
  return {
    ...base,
    mailboxSync: vi.fn(async () => status),
    indexEmails: vi.fn(base.indexEmails),
    chat: vi.fn(base.chat),
  };
}

const other = { ...sampleEmail, id: "msg-other-1", conversationId: "conv-other", subject: "Lunch on Thursday?", body: "Shall we grab lunch on Thursday?" };

beforeEach(() => {
  clearCache();
  clearIndexed();
});

describe("indexed-ids tracker", () => {
  it("remembers what was sent, bounded and scoped, and filters the rest", () => {
    expect(isIndexed("a")).toBe(false);
    markIndexed(["a", "b"]);
    expect(isIndexed("a")).toBe(true);
    expect(notYetIndexed([{ id: "a" }, { id: "c" }, { id: "" }])).toEqual([{ id: "c" }]);
    markIndexed(["a"]); // no duplicates
    expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith("oao.addin.indexedIds"))!)!)).toEqual(["a", "b"]);
    clearIndexed();
    expect(isIndexed("a")).toBe(false);
  });
});

describe("ChatTab — 'All emails' scope", () => {
  it("tells the user the index is empty and that only browsed emails are indexed without Graph", async () => {
    const api = apiWith(mockSyncStatus({ enabled: false, state: "disabled", indexedEmails: 0 }));
    renderWithProviders(<ChatTab />, { api });
    const status = await screen.findByTestId("chat-index-status");
    expect(status).toHaveTextContent("No email indexed yet: open or select emails");
    expect(status).toHaveTextContent("without Microsoft Graph, only the emails opened in the pane or selected are indexed");
    expect(status).toHaveAttribute("data-indexed", "0");
  });

  it("indexes the browsed emails once before a mailbox-wide question, then reports what the answer searched", async () => {
    cacheItem(sampleEmail);
    cacheItem(other);
    const api = apiWith(mockSyncStatus({ enabled: false, state: "disabled", indexedEmails: 0 }));
    renderWithProviders(<ChatTab />, { api });
    await screen.findByTestId("chat-index-status");

    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Where is the mandate approval?" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await screen.findByTestId("assistant-card");
    // Both cached emails went to the index, in one call, before the question.
    expect(api.indexEmails).toHaveBeenCalledTimes(1);
    const sent = (api.indexEmails.mock.calls[0]![0] as { emails: Array<{ id: string }> }).emails.map((e) => e.id).sort();
    expect(sent).toEqual([other.id, sampleEmail.id].sort());
    expect(api.indexEmails.mock.invocationCallOrder[0]!).toBeLessThan(api.chat.mock.invocationCallOrder[0]!);
    // No email open, no pinned scope: the question is mailbox-wide.
    expect(api.chat.mock.calls[0]![0]).toMatchObject({ scope: {}, message: "Where is the mandate approval?" });
    expect(api.chat.mock.calls[0]![0]).not.toHaveProperty("currentEmail.id");
    // The answer says what it searched, and the status line follows the server's count.
    expect(screen.getByTestId("chat-retrieval")).toHaveTextContent("3 email(s) found among 1284 indexed");
    expect(screen.getByTestId("chat-index-status")).toHaveTextContent("1284 emails indexed");

    // A second question does not re-send the same emails.
    fireEvent.change(box, { target: { value: "And the KYC?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(2));
    expect(api.indexEmails).toHaveBeenCalledTimes(1);
    expect(isIndexed(sampleEmail.id)).toBe(true);
  });

  it("in the read pane, 'This conversation' keeps the opened email as the scope and 'All emails' widens it", async () => {
    cacheItem(other);
    const api = apiWith(mockSyncStatus({ enabled: true, indexedEmails: 12 }));
    renderWithProviders(<ChatTab email={sampleEmail} />, { api });
    // Conversation scope by default: no status line (the scope is one thread), no auto-index.
    expect(screen.queryByTestId("chat-index-status")).not.toBeInTheDocument();
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "What does Sarah need?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByTestId("assistant-card");
    expect(api.indexEmails).not.toHaveBeenCalled();
    expect(api.chat.mock.calls[0]![0]).toMatchObject({ scope: { conversationId: sampleEmail.conversationId }, currentEmail: { id: sampleEmail.id } });

    fireEvent.click(screen.getByRole("button", { name: "All emails" }));
    const status = await screen.findByTestId("chat-index-status");
    // The first answer already carried the server's count (1284 in the mock), which supersedes the initial 12.
    expect(status).toHaveTextContent("1284 emails indexed");
    expect(status).not.toHaveTextContent("without Microsoft Graph");
    fireEvent.change(box, { target: { value: "Who invited me to lunch?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.chat).toHaveBeenCalledTimes(2));
    // Mailbox-wide: the opened email is still passed as context, the scope is the whole mailbox …
    expect(api.chat.mock.calls[1]![0]).toMatchObject({ scope: {}, currentEmail: { id: sampleEmail.id } });
    // … and the cached, never-indexed email was sent first.
    expect(api.indexEmails).toHaveBeenCalledTimes(1);
    expect((api.indexEmails.mock.calls[0]![0] as { emails: Array<{ id: string }> }).emails.map((e) => e.id)).toEqual([other.id]);
  });
});

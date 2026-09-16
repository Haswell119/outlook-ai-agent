import { describe, expect, it, vi } from "vitest";
import { MsalGraphClient, deltaTokenFromLink, graphMessageToEmail, htmlToText } from "../../src/adapters/graph/client.js";
import { DisabledGraphClient } from "../../src/adapters/graph/client.js";
import type { MailboxAccess } from "../../src/ports/graph.js";

/** Scripted fetch: each entry answers the next matching request. */
function fakeFetch(responses: Array<{ status?: number; headers?: Record<string, string>; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift() ?? { status: 200, body: {} };
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: { get: (h: string) => next.headers?.[h.toLowerCase()] ?? null },
      json: async () => next.body ?? {},
      text: async () => JSON.stringify(next.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) => {
  const c = new MsalGraphClient({ tenantId: "t", clientId: "c", clientSecret: "s", fetchImpl, maxRetries: 3, ...over });
  // Bypass MSAL: token acquisition is Microsoft's code, not ours.
  (c as unknown as { tokenFor: (a: MailboxAccess) => Promise<string> }).tokenFor = async () => "graph-token";
  return c;
};

const APP: MailboxAccess = { kind: "app", userPrincipalName: "ana@northbridge.example" };
const message = (id: string, over: Record<string, unknown> = {}) => ({ id, subject: `Subject ${id}`, receivedDateTime: "2026-06-10T08:00:00Z", body: { contentType: "text", content: "Body." }, ...over });

describe("graph helpers", () => {
  it("converts HTML bodies to text", () => {
    expect(htmlToText("<p>Hello<br>world</p><script>bad()</script>&amp;")).toBe("Hello\nworld\n&");
  });

  it("maps a Graph message onto EmailContext", () => {
    const e = graphMessageToEmail({ id: "m1", subject: "S", from: { emailAddress: { name: "Ana", address: "ana@client.example" } }, toRecipients: [{ emailAddress: { address: "b@northbridge.example" } }], body: { contentType: "html", content: "<p>Hi</p>" }, categories: ["X"] });
    expect(e).toMatchObject({ id: "m1", subject: "S", body: "Hi", categories: ["X"] });
    expect(e.from).toEqual({ name: "Ana", address: "ana@client.example" });
  });

  it("extracts the delta token from a deltaLink", () => {
    expect(deltaTokenFromLink("https://graph.microsoft.com/v1.0/me/x/delta?$deltatoken=abc%3D123")).toBe("abc=123");
    expect(deltaTokenFromLink(undefined)).toBeUndefined();
    expect(deltaTokenFromLink("https://graph.microsoft.com/no-token")).toBeUndefined();
  });

  it("the disabled client throws for every real operation but never for registration", async () => {
    const d = new DisabledGraphClient();
    expect(d.enabled).toBe(false);
    // These throw synchronously, which is what the services catch as GraphDisabledError.
    expect(() => d.getMessage()).toThrow(/disabled/);
    expect(() => d.deltaInbox()).toThrow(/disabled/);
    expect(() => d.listGroupMemberUpns()).toThrow(/disabled/);
    await expect(d.rememberDelegatedUser()).resolves.toBeUndefined();
    await expect(d.canAccess()).resolves.toBe(false);
  });
});

describe("MsalGraphClient — delta query", () => {
  it("asks for plain-text bodies and returns the delta token", async () => {
    const { impl, calls } = fakeFetch([{ body: { value: [message("m1"), message("m2")], "@odata.deltaLink": "https://graph/x?$deltatoken=D1" } }]);
    const page = await client(impl).deltaInbox(APP, undefined, 50);

    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(page.deltaToken).toBe("D1");
    expect(page.hasMore).toBe(false);
    expect(calls[0]!.url).toContain("/users/ana%40northbridge.example/mailFolders/inbox/messages/delta");
    expect(calls[0]!.headers.prefer).toContain('outlook.body-content-type="text"');
  });

  it("replays a stored delta token", async () => {
    const { impl, calls } = fakeFetch([{ body: { value: [], "@odata.deltaLink": "https://graph/x?$deltatoken=D2" } }]);
    await client(impl).deltaInbox(APP, "D1", 50);
    expect(calls[0]!.url).toContain("$deltatoken=D1");
  });

  it("follows @odata.nextLink and reports removed ids", async () => {
    const { impl } = fakeFetch([
      { body: { value: [message("m1"), { id: "gone", "@removed": { reason: "deleted" } }], "@odata.nextLink": "https://graph/next" } },
      { body: { value: [message("m2")], "@odata.deltaLink": "https://graph/x?$deltatoken=D3" } },
    ]);
    const page = await client(impl).deltaInbox(APP, undefined, 50);
    expect(page.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(page.removedIds).toEqual(["gone"]);
    expect(page.deltaToken).toBe("D3");
  });

  it("stops at maxMessages and says there is more", async () => {
    const { impl } = fakeFetch([{ body: { value: [message("m1"), message("m2"), message("m3")], "@odata.nextLink": "https://graph/next" } }]);
    const page = await client(impl).deltaInbox(APP, undefined, 2);
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("fetches attachment metadata for flagged messages in one $batch", async () => {
    const { impl, calls } = fakeFetch([
      { body: { value: [message("m1", { hasAttachments: true }), message("m2")], "@odata.deltaLink": "https://graph/x?$deltatoken=D4" } },
      { body: { responses: [{ id: "0", status: 200, body: { value: [{ id: "a1", name: "invite.ics", contentType: "text/calendar" }] } }] } },
    ]);
    const page = await client(impl).deltaInbox(APP, undefined, 50);
    expect(calls[1]!.url).toContain("/$batch");
    expect((calls[1]!.body as { requests: unknown[] }).requests).toHaveLength(1);
    expect(page.messages[0]!.attachments).toEqual([{ id: "a1", name: "invite.ics", size: undefined, contentType: "text/calendar", isInline: undefined }]);
    expect(page.messages[1]!.attachments).toEqual([]);
  });

  it("an attachment fetch failure does not fail the sync", async () => {
    const { impl } = fakeFetch([{ body: { value: [message("m1", { hasAttachments: true })], "@odata.deltaLink": "https://graph/x?$deltatoken=D5" } }, { status: 500, body: { error: "boom" } }]);
    const page = await client(impl).deltaInbox(APP, undefined, 50);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.attachments).toEqual([]);
  });
});

describe("MsalGraphClient — throttling", () => {
  it("honours Retry-After on 429 and then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = fakeFetch([{ status: 429, headers: { "retry-after": "2" }, body: {} }, { body: { value: [message("m1")], "@odata.deltaLink": "https://graph/x?$deltatoken=D" } }]);
      const p = client(impl).deltaInbox(APP, undefined, 50);
      await vi.advanceTimersByTimeAsync(2100);
      const page = await p;
      expect(page.messages).toHaveLength(1);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off on 503 and gives up after maxRetries", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = fakeFetch(Array.from({ length: 6 }, () => ({ status: 503, body: {} })));
      const p = client(impl).deltaInbox(APP, undefined, 50);
      const assertion = expect(p).rejects.toThrow(/HTTP 503/);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(calls.length).toBe(4); // initial + 3 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a sub-request that was throttled inside a $batch", async () => {
    const { impl, calls } = fakeFetch([
      { body: { responses: [{ id: "0", status: 429 }, { id: "1", status: 200, body: { ok: true } }] } },
      { body: { recovered: true } },
    ]);
    const c = client(impl);
    const out = await c.batch<{ ok?: boolean; recovered?: boolean }>(APP, [
      { id: "0", method: "GET", url: "/users/x/messages/1" },
      { id: "1", method: "GET", url: "/users/x/messages/2" },
    ]);
    expect(calls).toHaveLength(2);
    expect(out.find((r) => r.id === "0")).toMatchObject({ status: 200, body: { recovered: true } });
  });

  it("splits a $batch into chunks of 20", async () => {
    const { impl, calls } = fakeFetch([{ body: { responses: [] } }, { body: { responses: [] } }]);
    await client(impl).batch(APP, Array.from({ length: 25 }, (_, i) => ({ id: String(i), method: "GET" as const, url: `/users/x/messages/${i}` })));
    expect(calls).toHaveLength(2);
    expect((calls[0]!.body as { requests: unknown[] }).requests).toHaveLength(20);
    expect((calls[1]!.body as { requests: unknown[] }).requests).toHaveLength(5);
  });
});

describe("MsalGraphClient — group expansion", () => {
  it("pages through group members", async () => {
    const { impl } = fakeFetch([
      { body: { value: [{ userPrincipalName: "a@northbridge.example" }], "@odata.nextLink": "https://graph/next" } },
      { body: { value: [{ userPrincipalName: "b@northbridge.example" }, {}] } },
    ]);
    const c = client(impl);
    (c as unknown as { appToken: () => Promise<string> }).appToken = async () => "app-token";
    expect(await c.listGroupMemberUpns("g1")).toEqual(["a@northbridge.example", "b@northbridge.example"]);
  });
});

describe("MsalGraphClient — message operations", () => {
  const withOboToken = (impl: typeof fetch) => {
    const c = client(impl);
    (c as unknown as { graphToken: () => Promise<string> }).graphToken = async () => "obo-token";
    return c;
  };

  it("fetches one message with attachments expanded and plain-text body", async () => {
    const { impl, calls } = fakeFetch([{ body: message("m1", { attachments: [{ id: "a", name: "f.pdf" }] }) }]);
    const e = await withOboToken(impl).getMessage("sso", "AAMk/1+2=");
    expect(e.attachments.map((a) => a.name)).toEqual(["f.pdf"]);
    expect(calls[0]!.url).toContain("/me/messages/AAMk%2F1%2B2%3D");
    expect(calls[0]!.url).toContain("$expand=attachments");
    expect(calls[0]!.headers.prefer).toContain("text");
  });

  it("filters a conversation and orders it oldest first", async () => {
    const { impl, calls } = fakeFetch([{ body: { value: [message("m1"), message("m2")] } }]);
    const msgs = await withOboToken(impl).getConversationMessages("sso", "conv'1");
    expect(msgs).toHaveLength(2);
    expect(decodeURIComponent(calls[0]!.url)).toContain("conversationId eq 'conv''1'");
    expect(calls[0]!.url).toContain("$orderby=receivedDateTime asc");
  });

  it("caps listRecentMessages at 100", async () => {
    const { impl, calls } = fakeFetch([{ body: { value: [] } }]);
    await withOboToken(impl).listRecentMessages("sso", 5000);
    expect(calls[0]!.url).toContain("$top=100");
  });

  it("creates a To Do task in the default list", async () => {
    const { impl, calls } = fakeFetch([{ body: { value: [{ id: "other" }, { id: "list-1", wellknownListName: "defaultList" }] } }, { body: { id: "task-1" } }]);
    const r = await withOboToken(impl).createTodoTask("sso", { title: "Chase KYC", dueDateTime: "2026-06-20T09:00:00Z" });
    expect(r.id).toBe("task-1");
    expect(calls[1]!.url).toContain("/me/todo/lists/list-1/tasks");
    expect(calls[1]!.body).toMatchObject({ title: "Chase KYC", dueDateTime: { dateTime: "2026-06-20T09:00:00Z", timeZone: "UTC" } });
  });

  it("fails clearly when the mailbox has no To Do list", async () => {
    const { impl } = fakeFetch([{ body: { value: [] } }]);
    await expect(withOboToken(impl).createTodoTask("sso", { title: "x" })).rejects.toThrow(/No To Do list/);
  });

  it("creates a reminder event, moves, categorises and flags", async () => {
    const { impl, calls } = fakeFetch([{ body: { id: "ev-1" } }, { body: { id: "m-1" } }, { status: 204 }, { status: 204 }]);
    const c = withOboToken(impl);
    expect((await c.createCalendarEvent("sso", { subject: "Follow-up", start: "2026-06-20T09:00:00Z", end: "2026-06-20T09:30:00Z" })).id).toBe("ev-1");
    expect((await c.moveMessage("sso", "m1", "archive")).id).toBe("m-1");
    await c.updateCategories("sso", "m1", ["Client mandate"]);
    await c.flagMessage("sso", "m1", true);

    expect(calls[0]!.body).toMatchObject({ isReminderOn: true });
    expect(calls[1]!.body).toEqual({ destinationId: "archive" });
    expect(calls[2]!.body).toEqual({ categories: ["Client mandate"] });
    expect(calls[3]!.body).toEqual({ flag: { flagStatus: "flagged" } });
  });

  it("surfaces a Graph error with its status and a truncated body", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { error: { code: "ErrorAccessDenied" } } }]);
    await expect(withOboToken(impl).listRecentMessages("sso", 10)).rejects.toThrow(/HTTP 403.*ErrorAccessDenied/s);
  });
});

/**
 * The OBO cache is keyed by the *incoming* Office SSO token, which rotates
 * roughly hourly per user. It was never evicted, so a long-lived pod grew one
 * entry — each holding a live Graph access token — per user per rotation, for
 * the life of the process.
 */
describe("OBO token cache is bounded", () => {
  const internals = (c: MsalGraphClient) =>
    c as unknown as {
      oboCache: Map<string, { token: string; expiresAt: number }>;
      pruneOboCache: () => void;
    };

  it("drops expired entries and caps the number of live ones", () => {
    const c = new MsalGraphClient({ tenantId: "t", clientId: "c", clientSecret: "s" });
    const inner = internals(c);
    inner.oboCache.set("stale", { token: "t1", expiresAt: Date.now() - 1000 });
    inner.oboCache.set("fresh", { token: "t2", expiresAt: Date.now() + 600_000 });
    inner.pruneOboCache();
    expect(inner.oboCache.has("stale")).toBe(false);
    expect(inner.oboCache.has("fresh")).toBe(true);

    for (let i = 0; i < 600; i++) inner.oboCache.set(`tok-${i}`, { token: "x", expiresAt: Date.now() + 600_000 });
    inner.pruneOboCache();
    expect(inner.oboCache.size).toBeLessThanOrEqual(500);
    // Oldest-first eviction: the newest entries survive.
    expect(inner.oboCache.has("tok-599")).toBe(true);
  });
});

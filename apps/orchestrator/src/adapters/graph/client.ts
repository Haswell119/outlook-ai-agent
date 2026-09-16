import { ConfidentialClientApplication } from "@azure/msal-node";
import type { EmailContext } from "@oao/shared";
import { GraphDisabledError } from "../../errors.js";
import type { GraphClient, GraphDeltaPage, MailboxAccess } from "../../ports/graph.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["https://graph.microsoft.com/.default"];

/** Fields fetched for a message: everything `EmailContext` needs and nothing else. */
const MESSAGE_SELECT = "id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,hasAttachments,categories,importance,isRead,webLink,parentFolderId";

export interface GraphOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** `obo` (delegated, default) or `app` (client credentials + application access policy). */
  authMode?: "obo" | "app";
  fetchImpl?: typeof fetch;
  /** Retries on 429/503 (default 4). */
  maxRetries?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void; debug: (obj: unknown, msg?: string) => void };
}

/** Graph client that always throws `GraphDisabledError` (GRAPH_ENABLED=false). */
export class DisabledGraphClient implements GraphClient {
  readonly enabled = false;
  private fail(): never {
    throw new GraphDisabledError();
  }
  getMessage(): Promise<EmailContext> {
    return this.fail();
  }
  getConversationMessages(): Promise<EmailContext[]> {
    return this.fail();
  }
  listRecentMessages(): Promise<EmailContext[]> {
    return this.fail();
  }
  createTodoTask(): Promise<{ id: string }> {
    return this.fail();
  }
  createCalendarEvent(): Promise<{ id: string }> {
    return this.fail();
  }
  moveMessage(): Promise<{ id: string }> {
    return this.fail();
  }
  updateCategories(): Promise<void> {
    return this.fail();
  }
  flagMessage(): Promise<void> {
    return this.fail();
  }
  deltaInbox(): Promise<GraphDeltaPage> {
    return this.fail();
  }
  async rememberDelegatedUser(): Promise<undefined> {
    return undefined; // no-op rather than throwing: called opportunistically on every request
  }
  async canAccess(): Promise<boolean> {
    return false;
  }
  listGroupMemberUpns(): Promise<string[]> {
    return this.fail();
  }
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  bccRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  receivedDateTime?: string;
  sentDateTime?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  hasAttachments?: boolean;
  attachments?: Array<{ id?: string; name?: string; size?: number; contentType?: string; isInline?: boolean }>;
  categories?: string[];
  importance?: "low" | "normal" | "high";
  isRead?: boolean;
  webLink?: string;
  parentFolderId?: string;
  "@removed"?: { reason?: string };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function graphMessageToEmail(m: GraphMessage): EmailContext {
  const addr = (r?: { emailAddress?: { name?: string; address?: string } }) => ({ name: r?.emailAddress?.name, address: r?.emailAddress?.address ?? "" });
  const body = m.body?.contentType?.toLowerCase() === "html" ? htmlToText(m.body.content ?? "") : (m.body?.content ?? m.bodyPreview ?? "");
  return {
    id: m.id,
    conversationId: m.conversationId,
    internetMessageId: m.internetMessageId,
    subject: m.subject ?? "",
    from: m.from?.emailAddress?.address ? addr(m.from) : undefined,
    to: (m.toRecipients ?? []).map(addr),
    cc: (m.ccRecipients ?? []).map(addr),
    bcc: (m.bccRecipients ?? []).map(addr),
    receivedAt: m.receivedDateTime,
    sentAt: m.sentDateTime,
    body,
    bodyPreview: m.bodyPreview,
    attachments: (m.attachments ?? []).map((a) => ({ id: a.id, name: a.name ?? "attachment", size: a.size, contentType: a.contentType, isInline: a.isInline })),
    categories: m.categories ?? [],
    importance: m.importance,
    isRead: m.isRead,
    folder: m.parentFolderId,
    webLink: m.webLink,
  };
}

/** Extract the `$deltatoken` from a Graph `@odata.deltaLink`. */
export function deltaTokenFromLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const m = /[?&]\$deltatoken=([^&]+)/i.exec(link);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One entry of a `$batch` request. */
export interface BatchRequest {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BatchResponse<T = unknown> {
  id: string;
  status: number;
  body?: T;
}

/**
 * Microsoft Graph over plain `fetch` (no SDK).
 *
 * Production behaviour built in:
 *  - **Throttling**: 429 and 503 are retried, honouring `Retry-After`, then
 *    exponential backoff with jitter. Graph *will* throttle a 50-mailbox sync,
 *    so this is the difference between a worker that keeps up and one that dies.
 *  - **`$batch`**: up to 20 requests per round-trip, which is how a delta page
 *    of 50 messages fetches its attachment metadata in 3 calls instead of 50.
 *  - **`Prefer: outlook.body-content-type="text"`**: Graph returns plain text
 *    directly, so we neither download nor strip HTML (a ~60 % payload saving,
 *    and a smaller prompt).
 *  - **Pagination**: `@odata.nextLink` is followed up to the caller's cap.
 *  - **Token cache**: OBO results are kept in the MSAL cache so the background
 *    worker can refresh silently (`MailboxAccess.kind = "cached"`).
 */
export class MsalGraphClient implements GraphClient {
  readonly enabled = true;
  private readonly msal: ConfidentialClientApplication;
  private readonly fetchImpl: typeof fetch;
  /** How the client was configured (diagnostics; the per-call `MailboxAccess` is what decides). */
  readonly authMode: "obo" | "app";
  private readonly maxRetries: number;
  private readonly log: NonNullable<GraphOptions["logger"]>;
  /**
   * OBO exchange results, keyed by the incoming user token.
   *
   * Bounded on purpose: the key is a short-lived Office SSO token, so a
   * long-running pod would otherwise accumulate one entry — holding a live
   * Graph access token — per user *per token rotation*, for the life of the
   * process. Expired entries are dropped on every write and the map is capped.
   */
  private readonly oboCache = new Map<string, { token: string; expiresAt: number; homeAccountId?: string }>();
  private static readonly OBO_CACHE_MAX = 500;
  private appTokenCache: { token: string; expiresAt: number } | undefined;
  /** Message ids flagged `hasAttachments` by a delta page, pending a `$batch` fetch. */
  private readonly hasAttachments = new Set<string>();

  constructor(opts: GraphOptions) {
    this.msal = new ConfidentialClientApplication({ auth: { clientId: opts.clientId, clientSecret: opts.clientSecret, authority: `https://login.microsoftonline.com/${opts.tenantId}` } });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authMode = opts.authMode ?? "obo";
    this.maxRetries = opts.maxRetries ?? 4;
    this.log = opts.logger ?? { warn: () => undefined, debug: () => undefined };
  }

  /* -------------------------------- tokens ------------------------------ */

  private async graphToken(userToken: string): Promise<string> {
    const cached = this.oboCache.get(userToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const result = await this.msal.acquireTokenOnBehalfOf({ oboAssertion: userToken, scopes: SCOPES });
    if (!result?.accessToken) throw new Error("OBO token exchange failed");
    this.pruneOboCache();
    this.oboCache.set(userToken, { token: result.accessToken, expiresAt: result.expiresOn?.getTime() ?? Date.now() + 5 * 60_000, homeAccountId: result.account?.homeAccountId });
    return result.accessToken;
  }

  /** Drop expired OBO entries, then evict oldest-first if still over the cap. */
  private pruneOboCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.oboCache) if (entry.expiresAt <= now) this.oboCache.delete(key);
    // Map iteration is insertion-ordered, so this evicts the least recently added.
    while (this.oboCache.size >= MsalGraphClient.OBO_CACHE_MAX) {
      const oldest = this.oboCache.keys().next();
      if (oldest.done) break;
      this.oboCache.delete(oldest.value);
    }
  }

  /** Client-credentials token (application permissions). */
  private async appToken(): Promise<string> {
    if (this.appTokenCache && this.appTokenCache.expiresAt > Date.now() + 60_000) return this.appTokenCache.token;
    const r = await this.msal.acquireTokenByClientCredential({ scopes: SCOPES });
    if (!r?.accessToken) throw new Error("client-credentials token acquisition failed");
    this.appTokenCache = { token: r.accessToken, expiresAt: r.expiresOn?.getTime() ?? Date.now() + 30 * 60_000 };
    return r.accessToken;
  }

  /** Silent refresh of a remembered delegated account. */
  private async silentToken(homeAccountId: string): Promise<string | undefined> {
    try {
      const account = await this.msal.getTokenCache().getAccountByHomeId(homeAccountId);
      if (!account) return undefined;
      const r = await this.msal.acquireTokenSilent({ account, scopes: SCOPES });
      return r?.accessToken ?? undefined;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "silent Graph token refresh failed — mailbox needs a fresh SSO call");
      return undefined;
    }
  }

  private async tokenFor(access: MailboxAccess): Promise<string> {
    if (access.kind === "obo") return this.graphToken(access.userToken);
    if (access.kind === "app") return this.appToken();
    const t = await this.silentToken(access.homeAccountId);
    if (!t) throw new Error(`no cached delegated token for ${access.userPrincipalName}`);
    return t;
  }

  /** `/me/...` for delegated access, `/users/{upn}/...` for application access. */
  private base(access: MailboxAccess): string {
    return access.kind === "obo" ? "/me" : `/users/${encodeURIComponent(access.userPrincipalName)}`;
  }

  async rememberDelegatedUser(userToken: string): Promise<{ homeAccountId: string } | undefined> {
    try {
      await this.graphToken(userToken);
      const homeAccountId = this.oboCache.get(userToken)?.homeAccountId;
      return homeAccountId ? { homeAccountId } : undefined;
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "could not remember delegated user for background sync");
      return undefined;
    }
  }

  async canAccess(access: MailboxAccess): Promise<boolean> {
    try {
      await this.tokenFor(access);
      return true;
    } catch {
      return false;
    }
  }

  /* -------------------------------- HTTP -------------------------------- */

  /** Request with Graph throttling handling (429/503 + Retry-After, backoff, jitter). */
  private async request(token: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(path.startsWith("http") ? path : `${GRAPH}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status !== 429 && res.status !== 503 && res.status !== 504) return res;
      if (attempt >= this.maxRetries) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      this.log.warn({ status: res.status, delay, attempt, path: path.slice(0, 120) }, "graph throttled, backing off");
      await sleep(delay);
    }
  }

  private async call<T>(token: string, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.request(token, method, path, body, extraHeaders);
    if (!res.ok) throw new Error(`Graph ${method} ${path.slice(0, 120)} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Plain-text bodies: Graph converts HTML for us. */
  private static readonly TEXT_BODY = { prefer: 'outlook.body-content-type="text"' };

  /** `$batch` helper: up to 20 requests per round-trip, throttling-aware. */
  async batch<T = unknown>(access: MailboxAccess, requests: BatchRequest[], reuseToken?: string): Promise<Array<BatchResponse<T>>> {
    if (!requests.length) return [];
    const token = reuseToken ?? (await this.tokenFor(access));
    const out: Array<BatchResponse<T>> = [];
    for (let i = 0; i < requests.length; i += 20) {
      const chunk = requests.slice(i, i + 20);
      const r = await this.call<{ responses?: Array<{ id: string; status: number; body?: T }> }>(token, "POST", "/$batch", { requests: chunk });
      for (const resp of r.responses ?? []) {
        // A throttled sub-request reports 429 inside the batch: retry it alone.
        if (resp.status === 429) {
          const req = chunk.find((c) => c.id === resp.id);
          if (req) {
            try {
              const body = await this.call<T>(token, req.method, req.url, req.body, req.headers);
              out.push({ id: resp.id, status: 200, body });
              continue;
            } catch {
              /* fall through with the 429 */
            }
          }
        }
        out.push(resp);
      }
    }
    return out;
  }

  /* ------------------------------ messages ------------------------------ */

  async getMessage(userToken: string, messageId: string): Promise<EmailContext> {
    const m = await this.call<GraphMessage>(await this.graphToken(userToken), "GET", `/me/messages/${encodeURIComponent(messageId)}?$select=${MESSAGE_SELECT}&$expand=attachments($select=id,name,size,contentType,isInline)`, undefined, MsalGraphClient.TEXT_BODY);
    return graphMessageToEmail(m);
  }

  async getConversationMessages(userToken: string, conversationId: string): Promise<EmailContext[]> {
    const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
    const r = await this.call<{ value: GraphMessage[] }>(await this.graphToken(userToken), "GET", `/me/messages?$filter=${filter}&$select=${MESSAGE_SELECT}&$orderby=receivedDateTime asc&$top=50`, undefined, MsalGraphClient.TEXT_BODY);
    return r.value.map(graphMessageToEmail);
  }

  async listRecentMessages(userToken: string, n: number): Promise<EmailContext[]> {
    const r = await this.call<{ value: GraphMessage[] }>(await this.graphToken(userToken), "GET", `/me/messages?$select=${MESSAGE_SELECT}&$orderby=receivedDateTime desc&$top=${Math.min(n, 100)}`, undefined, MsalGraphClient.TEXT_BODY);
    return r.value.map(graphMessageToEmail);
  }

  /**
   * Inbox delta query, following `@odata.nextLink` until `maxMessages` or the
   * `@odata.deltaLink` (end of the change set) is reached.
   */
  async deltaInbox(access: MailboxAccess, deltaToken: string | undefined, maxMessages: number): Promise<GraphDeltaPage> {
    const token = await this.tokenFor(access);
    let url = deltaToken
      ? `${this.base(access)}/mailFolders/inbox/messages/delta?$deltatoken=${encodeURIComponent(deltaToken)}`
      : `${this.base(access)}/mailFolders/inbox/messages/delta?$select=${MESSAGE_SELECT}&$top=${Math.min(maxMessages, 50)}`;

    const messages: EmailContext[] = [];
    const removedIds: string[] = [];
    let nextDelta: string | undefined;
    let hasMore = false;

    for (let page = 0; page < 20; page++) {
      const r = await this.call<{ value?: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(token, "GET", url, undefined, { ...MsalGraphClient.TEXT_BODY, prefer: `outlook.body-content-type="text", odata.maxpagesize=${Math.min(maxMessages, 50)}` });
      for (const m of r.value ?? []) {
        if (m["@removed"]) {
          removedIds.push(m.id);
          continue;
        }
        // `delta` cannot `$expand=attachments`; remember who has some and batch-fetch below.
        if (m.hasAttachments) this.hasAttachments.add(m.id);
        messages.push(graphMessageToEmail(m));
      }
      nextDelta = deltaTokenFromLink(r["@odata.deltaLink"]) ?? nextDelta;
      const next = r["@odata.nextLink"];
      if (!next) break;
      if (messages.length >= maxMessages) {
        hasMore = true;
        break;
      }
      url = next;
    }

    const page = messages.slice(0, maxMessages);
    await this.attachAttachmentMetadata(access, token, page);
    return { messages: page, deltaToken: nextDelta, hasMore: hasMore || messages.length > maxMessages, removedIds };
  }

  /**
   * Fill in attachment metadata for the messages that have any, in one `$batch`
   * per 20 messages instead of one request each.
   *
   * Triage needs it: a `.ics` / `text/calendar` part is what distinguishes a
   * meeting invitation from a conversation, and an unexpected attachment on an
   * automated message is a phishing signal. Best-effort — a failure here must
   * never fail the sync.
   */
  private async attachAttachmentMetadata(access: MailboxAccess, token: string, messages: EmailContext[]): Promise<void> {
    const needing = messages.filter((m) => m.attachments.length === 0 && this.hasAttachments.has(m.id));
    if (!needing.length) return;
    try {
      const responses = await this.batch<{ value?: Array<{ id?: string; name?: string; size?: number; contentType?: string; isInline?: boolean }> }>(
        access,
        needing.map((m, i) => ({ id: String(i), method: "GET" as const, url: `${this.base(access)}/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,size,contentType,isInline` })),
        token,
      );
      for (const r of responses) {
        const message = needing[Number(r.id)];
        if (!message || r.status >= 300) continue;
        message.attachments = (r.body?.value ?? []).map((a) => ({ id: a.id, name: a.name ?? "attachment", size: a.size, contentType: a.contentType, isInline: a.isInline }));
      }
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "could not fetch attachment metadata (triage falls back to subject/body signals)");
    } finally {
      for (const m of messages) this.hasAttachments.delete(m.id);
    }
  }

  async listGroupMemberUpns(groupId: string): Promise<string[]> {
    const token = await this.appToken();
    const out: string[] = [];
    let url = `/groups/${encodeURIComponent(groupId)}/members/microsoft.graph.user?$select=userPrincipalName&$top=100`;
    for (let page = 0; page < 20; page++) {
      const r = await this.call<{ value?: Array<{ userPrincipalName?: string }>; "@odata.nextLink"?: string }>(token, "GET", url);
      for (const u of r.value ?? []) if (u.userPrincipalName) out.push(u.userPrincipalName);
      const next = r["@odata.nextLink"];
      if (!next) break;
      url = next;
    }
    return out;
  }

  /* ------------------------------- actions ------------------------------ */

  async createTodoTask(userToken: string, task: { title: string; dueDateTime?: string; body?: string }): Promise<{ id: string }> {
    const token = await this.graphToken(userToken);
    const lists = await this.call<{ value: Array<{ id: string; wellknownListName?: string }> }>(token, "GET", `/me/todo/lists`);
    const list = lists.value.find((l) => l.wellknownListName === "defaultList") ?? lists.value[0];
    if (!list) throw new Error("No To Do list available");
    const payload: Record<string, unknown> = { title: task.title, body: task.body ? { content: task.body, contentType: "text" } : undefined };
    if (task.dueDateTime) payload.dueDateTime = { dateTime: task.dueDateTime, timeZone: "UTC" };
    return this.call<{ id: string }>(token, "POST", `/me/todo/lists/${list.id}/tasks`, payload);
  }

  async createCalendarEvent(userToken: string, event: { subject: string; start: string; end: string; body?: string }): Promise<{ id: string }> {
    return this.call<{ id: string }>(await this.graphToken(userToken), "POST", `/me/events`, {
      subject: event.subject,
      start: { dateTime: event.start, timeZone: "UTC" },
      end: { dateTime: event.end, timeZone: "UTC" },
      body: event.body ? { contentType: "text", content: event.body } : undefined,
      isReminderOn: true,
      reminderMinutesBeforeStart: 15,
    });
  }

  async moveMessage(userToken: string, messageId: string, destinationFolder: string): Promise<{ id: string }> {
    return this.call<{ id: string }>(await this.graphToken(userToken), "POST", `/me/messages/${encodeURIComponent(messageId)}/move`, { destinationId: destinationFolder });
  }

  async updateCategories(userToken: string, messageId: string, categories: string[]): Promise<void> {
    await this.call(await this.graphToken(userToken), "PATCH", `/me/messages/${encodeURIComponent(messageId)}`, { categories });
  }

  async flagMessage(userToken: string, messageId: string, flagged: boolean): Promise<void> {
    await this.call(await this.graphToken(userToken), "PATCH", `/me/messages/${encodeURIComponent(messageId)}`, { flag: { flagStatus: flagged ? "flagged" : "notFlagged" } });
  }
}

import { ConfidentialClientApplication } from "@azure/msal-node";
import type { EmailContext } from "@oao/shared";
import { GraphDisabledError } from "../../errors.js";
import type { GraphClient } from "../../ports/graph.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["https://graph.microsoft.com/.default"];

export interface GraphOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
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

/**
 * Microsoft Graph via On-Behalf-Of: the add-in's Office SSO token is exchanged
 * for a Graph token for the same user. Plain `fetch`, no Graph SDK.
 */
export class MsalGraphClient implements GraphClient {
  readonly enabled = true;
  private readonly msal: ConfidentialClientApplication;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(opts: GraphOptions) {
    this.msal = new ConfidentialClientApplication({ auth: { clientId: opts.clientId, clientSecret: opts.clientSecret, authority: `https://login.microsoftonline.com/${opts.tenantId}` } });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async graphToken(userToken: string): Promise<string> {
    const cached = this.tokenCache.get(userToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const result = await this.msal.acquireTokenOnBehalfOf({ oboAssertion: userToken, scopes: SCOPES });
    if (!result?.accessToken) throw new Error("OBO token exchange failed");
    this.tokenCache.set(userToken, { token: result.accessToken, expiresAt: result.expiresOn?.getTime() ?? Date.now() + 5 * 60_000 });
    return result.accessToken;
  }

  private async call<T>(userToken: string, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.graphToken(userToken);
    const res = await this.fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Graph ${method} ${path} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getMessage(userToken: string, messageId: string): Promise<EmailContext> {
    const m = await this.call<GraphMessage>(userToken, "GET", `/me/messages/${encodeURIComponent(messageId)}?$expand=attachments($select=id,name,size,contentType,isInline)`);
    return graphMessageToEmail(m);
  }
  async getConversationMessages(userToken: string, conversationId: string): Promise<EmailContext[]> {
    const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`);
    const r = await this.call<{ value: GraphMessage[] }>(userToken, "GET", `/me/messages?$filter=${filter}&$orderby=receivedDateTime asc&$top=50`);
    return r.value.map(graphMessageToEmail);
  }
  async listRecentMessages(userToken: string, n: number): Promise<EmailContext[]> {
    const r = await this.call<{ value: GraphMessage[] }>(userToken, "GET", `/me/messages?$orderby=receivedDateTime desc&$top=${Math.min(n, 100)}`);
    return r.value.map(graphMessageToEmail);
  }
  async createTodoTask(userToken: string, task: { title: string; dueDateTime?: string; body?: string }): Promise<{ id: string }> {
    const lists = await this.call<{ value: Array<{ id: string; wellknownListName?: string }> }>(userToken, "GET", `/me/todo/lists`);
    const list = lists.value.find((l) => l.wellknownListName === "defaultList") ?? lists.value[0];
    if (!list) throw new Error("No To Do list available");
    const payload: Record<string, unknown> = { title: task.title, body: task.body ? { content: task.body, contentType: "text" } : undefined };
    if (task.dueDateTime) payload.dueDateTime = { dateTime: task.dueDateTime, timeZone: "UTC" };
    return this.call<{ id: string }>(userToken, "POST", `/me/todo/lists/${list.id}/tasks`, payload);
  }
  async createCalendarEvent(userToken: string, event: { subject: string; start: string; end: string; body?: string }): Promise<{ id: string }> {
    return this.call<{ id: string }>(userToken, "POST", `/me/events`, {
      subject: event.subject,
      start: { dateTime: event.start, timeZone: "UTC" },
      end: { dateTime: event.end, timeZone: "UTC" },
      body: event.body ? { contentType: "text", content: event.body } : undefined,
      isReminderOn: true,
      reminderMinutesBeforeStart: 15,
    });
  }
  async moveMessage(userToken: string, messageId: string, destinationFolder: string): Promise<{ id: string }> {
    return this.call<{ id: string }>(userToken, "POST", `/me/messages/${encodeURIComponent(messageId)}/move`, { destinationId: destinationFolder });
  }
  async updateCategories(userToken: string, messageId: string, categories: string[]): Promise<void> {
    await this.call(userToken, "PATCH", `/me/messages/${encodeURIComponent(messageId)}`, { categories });
  }
  async flagMessage(userToken: string, messageId: string, flagged: boolean): Promise<void> {
    await this.call(userToken, "PATCH", `/me/messages/${encodeURIComponent(messageId)}`, { flag: { flagStatus: flagged ? "flagged" : "notFlagged" } });
  }
}

/**
 * Function file for ribbon commands and the OnMessageSend launch event (Smart Alerts).
 *
 * `onMessageSendHandler` runs the Compliance Guardian check on the draft being sent.
 *  - verdict "block" or "warn" → soft block (SendMode=PromptUser): the user sees the
 *    message and can still choose to send.
 *  - verdict "allow", or ANY error (backend down, SSO failure …) → allowEvent: true,
 *    so an outage never blocks the user.
 */
import { Routes, ComplianceCheckResponseSchema, type ComposeContext, type EmailAddress } from "@oao/shared";
import { getAuthHeaders } from "@/office/sso";
import { apiBaseUrl } from "@/api/client";
import { translate, detectLanguage } from "@/i18n";

type SendEvent = { completed: (options?: { allowEvent?: boolean; errorMessage?: string; cancelLabel?: string; commandId?: string }) => void };

function toAddresses(list: Office.EmailAddressDetails[] | undefined): EmailAddress[] {
  return (list ?? []).filter((d) => !!d?.emailAddress).map((d) => ({ name: d.displayName || undefined, address: d.emailAddress }));
}

function get<T>(fn: (cb: (r: Office.AsyncResult<T>) => void) => void, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    try {
      fn((r) => resolve(r.status === Office.AsyncResultStatus.Succeeded ? r.value : fallback));
    } catch {
      resolve(fallback);
    }
  });
}

async function readDraft(): Promise<ComposeContext> {
  const item = Office.context.mailbox.item as unknown as Office.MessageCompose;
  const [to, cc, bcc, subject, body] = await Promise.all([
    get<Office.EmailAddressDetails[]>((cb) => item.to.getAsync(cb), []),
    get<Office.EmailAddressDetails[]>((cb) => item.cc.getAsync(cb), []),
    get<Office.EmailAddressDetails[]>((cb) => item.bcc.getAsync(cb), []),
    get<string>((cb) => item.subject.getAsync(cb), ""),
    get<string>((cb) => item.body.getAsync(Office.CoercionType.Text, cb), ""),
  ]);
  const attachments = typeof item.getAttachmentsAsync === "function" ? await get<Office.AttachmentDetailsCompose[]>((cb) => item.getAttachmentsAsync(cb), []) : [];
  const profile = Office.context.mailbox.userProfile;
  return {
    from: profile?.emailAddress ? { name: profile.displayName, address: profile.emailAddress } : undefined,
    to: toAddresses(to),
    cc: toAddresses(cc),
    bcc: toAddresses(bcc),
    subject,
    body,
    attachments: attachments.map((a) => ({ id: a.id, name: a.name, size: a.size, isInline: a.isInline })),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function onMessageSendHandler(event: SendEvent): Promise<void> {
  const lang = detectLanguage();
  try {
    const draft = await readDraft();
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", "Accept-Language": lang, ...(await getAuthHeaders()) };
    const res = await withTimeout(fetch(`${apiBaseUrl()}${Routes.complianceCheck}`, { method: "POST", headers, body: JSON.stringify({ draft, language: lang }) }), 20_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = ComplianceCheckResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid response");
    const result = parsed.data;
    if (result.verdict === "allow" || result.issues.length === 0) {
      event.completed({ allowEvent: true });
      return;
    }
    const list = result.issues.slice(0, 5).map((i) => `• ${i.title} (${translate(lang, `risk.${i.severity}`)})`).join("\n");
    const title = result.issues.length === 1 ? translate(lang, "compliance.oneIssueDetected") : translate(lang, "compliance.issuesDetected", { count: result.issues.length });
    event.completed({ allowEvent: false, errorMessage: `${title}\n${list}\n\n${translate(lang, "compliance.addressIssues")}` });
  } catch (err) {
    console.warn("[oao] compliance check on send failed — allowing send", err);
    event.completed({ allowEvent: true });
  }
}

// Register the handler with Office (must be done in the global scope of the function file).
const actions = (globalThis as unknown as { Office?: { actions?: { associate: (name: string, fn: (arg?: unknown) => void) => void } } }).Office?.actions;
if (actions?.associate) {
  actions.associate("onMessageSendHandler", (arg?: unknown) => void onMessageSendHandler(arg as SendEvent));
}
if (typeof Office !== "undefined" && typeof Office.onReady === "function") {
  Office.onReady(() => undefined);
}

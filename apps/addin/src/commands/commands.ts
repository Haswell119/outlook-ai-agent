/**
 * Function file for ribbon commands and the OnMessageSend launch event
 * (Smart Alerts).
 *
 * ## Send-mode semantics
 *
 * The manifest declares `SendMode="PromptUser"`. That is the deliberate choice
 * for a 50-person firm: an add-in outage, an expired token or a slow model must
 * never stop someone sending an email. PromptUser means the user always keeps a
 * "Send anyway" escape hatch.
 *
 * On top of that the handler distinguishes the verdicts:
 *
 * | verdict | completed(...)                                          | effect                                   |
 * |---------|---------------------------------------------------------|------------------------------------------|
 * | allow   | `{ allowEvent: true }`                                   | sends, no dialog                         |
 * | warn    | `{ allowEvent: false, errorMessage, sendModeOverride:    | dialog listing the issues, "Send anyway" |
 * |         |   PromptUser, commandId }`                               | stays available even under a stricter    |
 * |         |                                                          | manifest SendMode                        |
 * | block   | `{ allowEvent: false, errorMessage, commandId }`          | dialog; the manifest SendMode decides    |
 * |         |                                                          | whether "Send anyway" is offered         |
 * | *error* | `{ allowEvent: true }`                                   | fail open, always                        |
 *
 * `sendModeOverride` and `commandId` need Mailbox 1.14, so both are feature
 * detected; on older hosts the same call is made without them.
 *
 * `commandId` points at the compose ribbon button, so the Outlook dialog shows
 * a "Show panel"-style button that opens the Compliance Guardian pane, matching
 * mock-up E. The same information is *also* pushed as a notification message on
 * the item, which is what the user sees when they dismiss the dialog.
 *
 * Only `OnMessageSend` is registered. `OnAppointmentSend` is deliberately not
 * implemented: the Compliance Guardian policy is about mail recipients and
 * attachments, and registering a handler we would immediately allow would only
 * add latency to every meeting the user books.
 */
import { Routes, ComplianceCheckResponseSchema, type ComposeContext, type EmailAddress, type Language } from "@oao/shared";
import { getAuthHeaders } from "@/office/sso";
import { apiBaseUrl } from "@/api/client";
import { translate, detectLanguage } from "@/i18n";
import { COMPOSE_PANE_COMMAND_ID } from "@/office/notifications";

/** `VITE_ONSEND_FAIL_MODE`: what happens when the compliance check itself fails. */
export const ON_SEND_FAIL_MODE: "open" | "closed" = (import.meta.env?.VITE_ONSEND_FAIL_MODE as string | undefined) === "closed" ? "closed" : "open";

export function failClosedMessage(lang: string): string {
  return lang.startsWith("fr")
    ? "Le contrôle de conformité est indisponible. L'envoi est bloqué par la politique de l'organisation ; réessayez dans quelques instants ou contactez le support."
    : "The compliance check is unavailable. Sending is blocked by your organisation's policy; retry in a moment or contact support.";
}

interface SendEventOptions {
  allowEvent?: boolean;
  errorMessage?: string;
  cancelLabel?: string;
  commandId?: string;
  contextData?: unknown;
  sendModeOverride?: unknown;
}

type SendEvent = { completed: (options?: SendEventOptions) => void };

/** Guarded requirement-set check (this file also runs in the JS-only runtime). */
function isSetSupported(name: string, version: string): boolean {
  try {
    return !!Office?.context?.requirements?.isSetSupported(name, version);
  } catch {
    return false;
  }
}

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
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Build the options object for a blocking / warning completion. */
export function buildSendOptions(args: {
  verdict: "warn" | "block";
  errorMessage: string;
  supportsOverride: boolean;
  promptUserOverride?: unknown;
  issueCount: number;
}): SendEventOptions {
  const options: SendEventOptions = { allowEvent: false, errorMessage: args.errorMessage };
  if (args.supportsOverride) {
    options.commandId = COMPOSE_PANE_COMMAND_ID;
    options.contextData = { source: "onMessageSend", issues: args.issueCount, verdict: args.verdict };
    // A warning must always stay overridable, whatever the manifest SendMode is.
    if (args.verdict === "warn" && args.promptUserOverride !== undefined) options.sendModeOverride = args.promptUserOverride;
  }
  return options;
}

/** Compose the dialog text: title, up to five issues, and what to do next. */
export function buildSendMessage(
  lang: Language,
  issues: Array<{ title: string; severity: "low" | "medium" | "high" }>,
): string {
  const list = issues
    .slice(0, 5)
    .map((i) => `• ${i.title} (${translate(lang, `risk.${i.severity}`)})`)
    .join("\n");
  const more = issues.length > 5 ? `\n${translate(lang, "compliance.andMore", { count: issues.length - 5 })}` : "";
  const title = issues.length === 1 ? translate(lang, "compliance.oneIssueDetected") : translate(lang, "compliance.issuesDetected", { count: issues.length });
  // Outlook caps the Smart Alerts dialog text; keep the actionable part first.
  return `${title}\n${list}${more}\n\n${translate(lang, "compliance.addressIssues")}`;
}

/** Best-effort compose banner so the issues survive the dialog being dismissed. */
async function addBanner(lang: Language, count: number, verdict: "warn" | "block"): Promise<void> {
  try {
    const { showComplianceBanner } = await import("@/office/notifications");
    await showComplianceBanner({ lang, issueCount: count, highestSeverity: null, verdict });
  } catch {
    /* never block the send path on a banner */
  }
}

export async function onMessageSendHandler(event: SendEvent): Promise<void> {
  const lang = detectLanguage();
  try {
    const draft = await readDraft();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": lang,
      ...(await getAuthHeaders()),
    };
    const res = await withTimeout(
      fetch(`${apiBaseUrl()}${Routes.complianceCheck}`, { method: "POST", headers, body: JSON.stringify({ draft, language: lang }) }),
      20_000,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = ComplianceCheckResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid response");
    const result = parsed.data;

    if (result.verdict === "allow" || result.issues.length === 0) {
      event.completed({ allowEvent: true });
      return;
    }

    const verdict = result.verdict === "block" ? "block" : "warn";
    const supportsOverride = isSetSupported("Mailbox", "1.14");
    const promptUserOverride = (Office as unknown as { MailboxEnums?: { SendModeOverride?: { PromptUser?: unknown } } })?.MailboxEnums?.SendModeOverride?.PromptUser;

    void addBanner(lang, result.issues.length, verdict);
    event.completed(
      buildSendOptions({
        verdict,
        errorMessage: buildSendMessage(lang, result.issues),
        supportsOverride,
        promptUserOverride,
        issueCount: result.issues.length,
      }),
    );
  } catch (err) {
    // Orchestrator unreachable / invalid answer. Behaviour is a build-time policy decision:
    //  - open   (default): the add-in is an assistant, not a gate — the email is sent.
    //  - closed: sending is refused until the compliance check is available again
    //            (financial-grade deployments that rely on Policy.blockOnHighRisk).
    console.warn(`[oao] compliance check on send failed — fail-${ON_SEND_FAIL_MODE}`, err);
    if (ON_SEND_FAIL_MODE === "closed") {
      event.completed({ allowEvent: false, errorMessage: failClosedMessage(lang) });
      return;
    }
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

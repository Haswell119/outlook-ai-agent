/**
 * `Office.context.mailbox.item.notificationMessages` — the compose-window
 * banner from mock-up E: "Compliance risk detected — Show panel".
 *
 * Three shapes, best available first:
 *  1. **insightMessage** (Mailbox 1.10+) — a banner with an action button that
 *     opens the task pane (`actionType: "showTaskPane"`, `commandId` pointing at
 *     the ribbon control declared in the manifest). This is the mock-up.
 *  2. **errorMessage** — no action button, but Outlook renders it in red, which
 *     is the right affordance for a blocking verdict on older hosts.
 *  3. **informationalMessage** — the safe default everywhere else.
 *
 * All of this is best-effort: a host that refuses a notification must never
 * break the pane, so every call is guarded and failures are swallowed. Banners
 * are keyed so re-running the check replaces the previous one instead of
 * stacking (Outlook allows max 5 keys per item).
 */
import type { Language, RiskLevel } from "@oao/shared";
import { translate } from "@/i18n";
import { asyncResult, isOfficeAvailable, isSetSupported, officeGlobal } from "./env";

/** Notification key for the compliance banner (max 32 chars, per Office.js). */
export const COMPLIANCE_KEY = "oaoCompliance";

/** Ribbon control id that opens the Compliance Guardian pane (see the manifest). */
export const COMPOSE_PANE_COMMAND_ID = "msgComposeCompliance";

function notifications(): Office.NotificationMessages | null {
  try {
    const item = officeGlobal()?.context?.mailbox?.item as unknown as { notificationMessages?: Office.NotificationMessages } | undefined;
    return item?.notificationMessages ?? null;
  } catch {
    return null;
  }
}

export function notificationsSupported(): boolean {
  return isOfficeAvailable() && !!notifications();
}

/** Outlook truncates the banner text; keep it short and informative. */
function clamp(text: string, max = 150): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface ComplianceBannerOptions {
  lang: Language;
  issueCount: number;
  highestSeverity: RiskLevel | null;
  verdict: "allow" | "warn" | "block";
}

/**
 * Show (or replace) the compliance banner in the compose window.
 * Returns the notification type actually used, or null when unsupported.
 */
export async function showComplianceBanner(opts: ComplianceBannerOptions): Promise<"insight" | "error" | "info" | null> {
  const api = notifications();
  if (!api) return null;
  const t = (key: string, params?: Record<string, string | number>) => translate(opts.lang, key, params);

  if (opts.issueCount === 0) {
    await clearComplianceBanner();
    return null;
  }

  const title = opts.issueCount === 1 ? t("compliance.oneIssueDetected") : t("compliance.issuesDetected", { count: opts.issueCount });
  const message = clamp(`${t("compliance.bannerTitle")} — ${title}`);

  // 1. insightMessage with a "Show panel" action.
  if (isSetSupported("Mailbox", "1.10")) {
    const insight: Office.NotificationMessageDetails = {
      type: "insightMessage" as Office.MailboxEnums.ItemNotificationMessageType,
      message,
      icon: "Icon.16",
      actions: [
        {
          actionType: "showTaskPane" as Office.MailboxEnums.ActionType,
          actionText: clamp(t("compliance.showPanel"), 30),
          commandId: COMPOSE_PANE_COMMAND_ID,
          contextData: { source: "onMessageSend", issues: opts.issueCount, verdict: opts.verdict },
        },
      ] as unknown as Office.NotificationMessageAction[],
    } as Office.NotificationMessageDetails;
    try {
      await replace(api, COMPLIANCE_KEY, insight);
      return "insight";
    } catch {
      /* fall through to a plain banner */
    }
  }

  // 2 / 3. Plain banner. `errorMessage` accepts no persistence flag.
  const plainType = (opts.verdict === "block" ? "errorMessage" : "informationalMessage") as Office.MailboxEnums.ItemNotificationMessageType;
  const plain: Office.NotificationMessageDetails =
    plainType === ("errorMessage" as Office.MailboxEnums.ItemNotificationMessageType)
      ? ({ type: plainType, message } as Office.NotificationMessageDetails)
      : ({ type: plainType, message, icon: "Icon.16", persistent: true } as Office.NotificationMessageDetails);
  try {
    await replace(api, COMPLIANCE_KEY, plain);
    return plainType === ("errorMessage" as Office.MailboxEnums.ItemNotificationMessageType) ? "error" : "info";
  } catch {
    return null;
  }
}

async function replace(api: Office.NotificationMessages, key: string, details: Office.NotificationMessageDetails): Promise<void> {
  // `replaceAsync` fails when the key does not exist yet, `addAsync` fails when
  // it does — try replace first, then add.
  try {
    await asyncResult<void>((cb) => api.replaceAsync(key, details, cb));
    return;
  } catch {
    /* not present yet */
  }
  await asyncResult<void>((cb) => api.addAsync(key, details, cb));
}

export async function clearComplianceBanner(): Promise<void> {
  const api = notifications();
  if (!api) return;
  try {
    await asyncResult<void>((cb) => api.removeAsync(COMPLIANCE_KEY, cb));
  } catch {
    /* nothing to remove */
  }
}

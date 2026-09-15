/**
 * Client-side execution of `pending_client` actions returned by the orchestrator.
 *
 * Supported `clientInstruction.operation` values (the backend must use these names):
 *   displayReplyForm · displayReplyAllForm · addCategory · flag · displayNewAppointmentForm ·
 *   openMoveDialog · applyLabel · removeAttachment · none
 */
import type { Language } from "@oao/shared";
import { translate } from "@/i18n";
import { asyncResult, isOfficeAvailable, isSetSupported, officeGlobal } from "./env";

export interface ClientInstruction {
  operation: string;
  parameters?: Record<string, unknown>;
}

export interface ClientActionOutcome {
  /** executed = done via Office.js · manual = user must finish by hand (toast) · failed = error */
  status: "executed" | "manual" | "failed";
  /** Message to show to the user (already localised). */
  message?: string;
}

function str(params: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = params?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11pt">${escaped.replace(/\r?\n/g, "<br/>")}</div>`;
}

/** Ensure a master category exists (Mailbox 1.8), best effort. */
async function ensureMasterCategory(name: string): Promise<void> {
  const master = officeGlobal()?.context.mailbox.masterCategories;
  if (!master || !isSetSupported("Mailbox", "1.8")) return;
  try {
    const existing = await asyncResult<Office.CategoryDetails[]>((cb) => master.getAsync(cb));
    if (existing.some((c) => c.displayName === name)) return;
    await asyncResult<void>((cb) =>
      master.addAsync([{ displayName: name, color: Office.MailboxEnums.CategoryColor.Preset7 }], cb),
    );
  } catch {
    /* category may already exist or the host refuses: addAsync on the item will tell */
  }
}

export async function executeClientAction(instruction: ClientInstruction, lang: Language): Promise<ClientActionOutcome> {
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
  const p = instruction.parameters ?? {};
  const op = instruction.operation;

  if (op === "none") return { status: "executed" };

  if (!isOfficeAvailable()) {
    return { status: "manual", message: t("actions.previewToast", { operation: op }) };
  }

  const mailbox = officeGlobal()!.context.mailbox;
  const item = mailbox.item as unknown as Office.MessageRead & Office.MessageCompose;

  try {
    switch (op) {
      case "displayReplyForm":
      case "displayReplyAllForm": {
        const body = str(p, "htmlBody") ?? textToHtml(str(p, "body", "text") ?? "");
        const options: Office.ReplyFormData = { htmlBody: body };
        if (op === "displayReplyAllForm") item.displayReplyAllForm(options);
        else item.displayReplyForm(options);
        return { status: "executed", message: t("actions.replyOpened") };
      }

      case "addCategory": {
        const category = str(p, "category", "name", "label") ?? "AI Orchestrator";
        if (!isSetSupported("Mailbox", "1.8") || !item.categories) {
          return { status: "manual", message: t("actions.manualGeneric") };
        }
        await ensureMasterCategory(category);
        await asyncResult<void>((cb) => item.categories.addAsync([category], cb));
        return { status: "executed", message: t("actions.categoryAdded", { category }) };
      }

      case "flag": {
        // No flag API in the Mailbox requirement sets → ask the user (Graph handles it server-side when enabled).
        return { status: "manual", message: t("actions.manualFlag") };
      }

      case "displayNewAppointmentForm": {
        const start = p.start ? new Date(String(p.start)) : new Date(Date.now() + 24 * 3600 * 1000);
        const end = p.end ? new Date(String(p.end)) : new Date(start.getTime() + 30 * 60 * 1000);
        mailbox.displayNewAppointmentForm({
          subject: str(p, "subject", "title") ?? "Follow-up",
          body: str(p, "body", "description") ?? "",
          start,
          end,
        });
        return { status: "executed", message: t("actions.appointmentOpened") };
      }

      case "openMoveDialog": {
        const folder = str(p, "folder", "folderName");
        return { status: "manual", message: t("actions.manualMove", { folder: folder ? ` → "${folder}"` : "" }) };
      }

      case "applyLabel": {
        const label = str(p, "label", "name") ?? "Confidential";
        // item.sensitivityLabel requires Mailbox 1.13 + IRM; we ask the user otherwise.
        const sl = (item as unknown as { sensitivityLabel?: { setAsync?: (id: string, cb: (r: Office.AsyncResult<void>) => void) => void } }).sensitivityLabel;
        const labelId = str(p, "labelId");
        if (labelId && sl?.setAsync && isSetSupported("Mailbox", "1.13")) {
          await asyncResult<void>((cb) => sl.setAsync!(labelId, cb));
          return { status: "executed", message: t("compliance.labelApplied") };
        }
        return { status: "manual", message: t("actions.manualLabel", { label }) };
      }

      case "removeAttachment": {
        if (!isSetSupported("Mailbox", "1.8") || typeof item.removeAttachmentAsync !== "function") {
          return { status: "manual", message: t("compliance.actionNotAvailable") };
        }
        let attachmentId = str(p, "attachmentId", "id");
        if (!attachmentId) {
          const list = await asyncResult<Office.AttachmentDetailsCompose[]>((cb) => item.getAttachmentsAsync(cb));
          const name = str(p, "name", "attachmentName");
          const target = list.find((a) => (name ? a.name === name : !a.isInline));
          attachmentId = target?.id;
        }
        if (!attachmentId) return { status: "failed", message: t("actions.noAttachment") };
        await asyncResult<void>((cb) => item.removeAttachmentAsync(attachmentId!, cb));
        return { status: "executed", message: t("compliance.attachmentRemoved") };
      }

      default:
        return { status: "manual", message: t("actions.manualGeneric") };
    }
  } catch (err) {
    return { status: "failed", message: t("errors.generic", { message: err instanceof Error ? err.message : String(err) }) };
  }
}

/** Open a message in Outlook by item id (falls back to a web link when given). */
export function openMessage(emailId: string | undefined, webLink?: string): boolean {
  if (webLink) {
    window.open(webLink, "_blank", "noopener");
    return true;
  }
  if (!emailId || !isOfficeAvailable()) return false;
  try {
    officeGlobal()!.context.mailbox.displayMessageForm(emailId);
    return true;
  } catch {
    return false;
  }
}

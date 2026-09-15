import type { ActionResult, DraftIntent, EmailContext, Language, ThreadContext } from "@oao/shared";
import type { OaoApi } from "@/api";
import { executeClientAction, textToHtml, type ClientActionOutcome } from "@/office/actions";
import { eventFromEmail, observeUserAction } from "@/office/observe";

export interface DraftReplyOptions {
  api: OaoApi;
  email: EmailContext;
  thread?: ThreadContext;
  intent?: DraftIntent;
  instructions?: string;
  lang: Language;
}

/** Ask the orchestrator for a draft and open it as a reply form (never sent). */
export async function runDraftReply(o: DraftReplyOptions): Promise<ClientActionOutcome & { auditId: string }> {
  const draft = await o.api.draftReply({ email: o.email, thread: o.thread, intent: o.intent ?? "custom", instructions: o.instructions, tone: "formal", language: o.lang });
  const outcome = await executeClientAction({ operation: "displayReplyForm", parameters: { htmlBody: textToHtml(draft.body), subject: draft.subject } }, o.lang);
  if (outcome.status === "executed") observeUserAction(eventFromEmail("reply", o.email, { via: "ai_draft" }));
  return { ...outcome, auditId: draft.auditId };
}

export type FinalStatus = "executed" | "pending_compliance" | "failed" | "rejected" | "manual";

export interface ExecutedResult {
  result: ActionResult;
  status: FinalStatus;
  message?: string;
}

/**
 * Execute `pending_client` results with Office.js and report back to the orchestrator.
 * `onProgress` is called after each action so the UI can update incrementally.
 */
export async function executeApprovedResults(
  results: ActionResult[],
  o: { api: OaoApi; lang: Language; email?: EmailContext; onProgress?: (r: ExecutedResult) => void },
): Promise<ExecutedResult[]> {
  const out: ExecutedResult[] = [];
  for (const result of results) {
    let entry: ExecutedResult;
    if (result.status === "pending_client" && result.clientInstruction) {
      const outcome = await executeClientAction(result.clientInstruction, o.lang);
      const status: FinalStatus = outcome.status === "executed" ? "executed" : outcome.status === "manual" ? "manual" : "failed";
      entry = { result, status, message: outcome.message };
      try {
        await o.api.reportActionResult(result.actionId, {
          actionId: result.actionId,
          status: outcome.status === "failed" ? "failed" : outcome.status === "manual" ? "cancelled" : "executed",
          message: outcome.message,
        });
      } catch {
        /* reporting is best-effort */
      }
      if (o.email && outcome.status === "executed") {
        const map: Partial<Record<string, "categorize" | "create_reminder" | "flag" | "reply" | "move_to_folder">> = {
          addCategory: "categorize",
          displayNewAppointmentForm: "create_reminder",
          flag: "flag",
          displayReplyForm: "reply",
          displayReplyAllForm: "reply",
          openMoveDialog: "move_to_folder",
        };
        const evType = map[result.clientInstruction.operation];
        if (evType) observeUserAction(eventFromEmail(evType, o.email, { actionId: result.actionId }));
      }
    } else if (result.status === "pending_client") {
      entry = { result, status: "failed", message: "missing clientInstruction" };
    } else {
      entry = { result, status: result.status as FinalStatus, message: result.message };
    }
    out.push(entry);
    o.onProgress?.(entry);
  }
  return out;
}

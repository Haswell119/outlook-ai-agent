import type { EmailContext, Language } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { cleanBody, estimateTokens, slimThread } from "./clean.js";
import { DEFAULT_BUDGET, formatEmail, SYSTEM_BASE, type PromptBudget } from "./format.js";

export const ANALYSIS_JSON_SHAPE = `{
  "language": "fr" | "en",
  "summary": "2-3 sentences: who writes, what they want, what matters",
  "decisions": ["decisions already taken or explicitly requested"],
  "pendingTasks": ["concrete tasks for the reader"],
  "risks": [{"code": "snake_case", "title": "...", "description": "...", "severity": "low|medium|high"}],
  "suggestedActions": [{"type": "draft_reply|create_reminder|create_task|categorize|flag|archive|move_to_folder|apply_label|notify|request_document|escalate_compliance|classify_email", "title": "...", "description": "...", "parameters": {}}],
  "quickReplies": ["max 3 short one-line replies the reader could send"],
  "classification": {"category": "project / client / type", "confidence": 0.0-1.0},
  "confidence": 0.0-1.0
}`;

/** Prompt-size telemetry recorded in the audit `details` (chars/4 token estimate). */
export interface PromptStats {
  /** Characters of body text before slimming. */
  rawChars: number;
  /** Characters actually sent. */
  chars: number;
  /** Rough prompt-token estimate. */
  tokens: number;
  /** Fraction of body characters removed by slimming, 0..1. */
  savedRatio: number;
  /** Thread messages dropped into the digest. */
  droppedMessages?: number;
}

export interface BuiltPrompt {
  request: LlmRequest;
  stats: PromptStats;
}

/**
 * Email-analysis prompt, with the body slimmed first (quoted history,
 * signatures, disclaimers and tracking URLs removed, then capped head+tail).
 * The thread, when included, is deduplicated and digested.
 */
export function buildEmailAnalysisPrompt(email: EmailContext, lang: Language, thread?: EmailContext[], budget: PromptBudget = DEFAULT_BUDGET): BuiltPrompt {
  const clean = cleanBody(email.body ?? "", { maxChars: budget.maxChars });
  const slimEmail: EmailContext = { ...email, body: clean.text };

  let threadBlock = "";
  let droppedMessages: number | undefined;
  let threadChars = 0;
  let rawThreadChars = 0;
  if (thread && thread.length > 1) {
    // Everything but the email being analysed is context.
    const earlier = thread.filter((m) => m.id !== email.id);
    const slim = slimThread(earlier, { maxMessages: budget.threadMaxMessages, maxChars: Math.floor(budget.maxChars / 2) });
    droppedMessages = slim.droppedMessages;
    threadChars = slim.chars;
    rawThreadChars = slim.originalChars;
    const rendered = slim.messages.map((m, i) => formatEmail(m, i + 1, budget.maxChars)).join("\n\n");
    threadBlock = ["", "", "Earlier messages of the conversation (context only, oldest first):", slim.digest, rendered].filter(Boolean).join("\n");
  }

  const content = [
    "Analyse the following email for its recipient and produce the JSON below.",
    "Rules: risks are business/compliance/operational risks (deadlines, missing documents, confidentiality, urgency).",
    'Suggested actions: at most 5, only from the allowed types, with helpful parameters (e.g. {"category": "..."}, {"title": "...", "dueDate": "YYYY-MM-DD"}).',
    "Never suggest sending or deleting anything.",
    "Quoted history, signatures and legal footers have been removed; `[…]` marks removed text.",
    "",
    formatEmail(slimEmail, undefined, budget.maxChars),
    threadBlock,
    "",
    "JSON schema:",
    ANALYSIS_JSON_SHAPE,
  ].join("\n");

  const request: LlmRequest = {
    useCase: "email_analysis",
    language: lang,
    json: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_BASE(lang) },
      { role: "user", content },
    ],
  };
  const rawChars = (email.body?.length ?? 0) + rawThreadChars;
  const chars = clean.chars + threadChars;
  return {
    request,
    stats: { rawChars, chars, tokens: estimateTokens(content), savedRatio: rawChars ? Number(Math.max(0, 1 - chars / rawChars).toFixed(3)) : 0, droppedMessages },
  };
}

import type { DraftIntent, EmailContext, Language, ThreadContext } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import type { BuiltPrompt } from "./analysis.js";
import { cleanBody, estimateTokens, slimThread } from "./clean.js";
import { DEFAULT_BUDGET, formatEmail, SYSTEM_BASE, type PromptBudget } from "./format.js";

export const INTENT_GUIDE: Record<DraftIntent, string> = {
  accept: "Accept / agree with the request or proposal, confirm next steps.",
  decline: "Politely decline, give a short reason and, when possible, an alternative.",
  acknowledge: "Acknowledge receipt, say what will happen next and when.",
  follow_up: "Follow up on something outstanding (document, answer, decision) with a clear ask and a date.",
  request_info: "Ask for the missing information / documents, listed clearly.",
  custom: "Follow the user's instructions.",
};

export const DRAFT_JSON_SHAPE = `{"subject": "Re: ...", "body": "plain-text reply, greeting + 1-3 short paragraphs + sign-off placeholder", "language": "fr"|"en", "confidence": 0.0-1.0}`;

export interface DraftPromptInput {
  email: EmailContext;
  thread?: ThreadContext;
  intent: DraftIntent;
  tone: "formal" | "neutral" | "friendly";
  instructions?: string;
  language: Language;
  senderName?: string;
}

/** Reply-draft prompt: the email is slimmed, the thread is digested (half the budget). */
export function buildDraftReplyPrompt(input: DraftPromptInput, budget: PromptBudget = DEFAULT_BUDGET): BuiltPrompt {
  const { email, thread, intent, tone, instructions, language, senderName } = input;
  const clean = cleanBody(email.body ?? "", { maxChars: budget.maxChars });
  const slimEmail: EmailContext = { ...email, body: clean.text };

  let threadBlock = "";
  let threadChars = 0;
  let rawThreadChars = 0;
  let droppedMessages: number | undefined;
  if (thread) {
    const slim = slimThread(
      thread.messages.filter((m) => m.id !== email.id),
      { maxMessages: Math.min(budget.threadMaxMessages, 8), maxChars: Math.floor(budget.maxChars / 2) },
    );
    threadChars = slim.chars;
    rawThreadChars = slim.originalChars;
    droppedMessages = slim.droppedMessages;
    if (slim.messages.length || slim.digest) {
      threadBlock = ["", "Conversation context:", slim.digest, ...slim.messages.map((m, i) => formatEmail(m, i + 1, budget.maxChars))].filter(Boolean).join("\n\n");
    }
  }

  const content = [
    `Write a reply DRAFT to the email below on behalf of ${senderName ?? "the recipient"}. The draft is never sent automatically; the user will edit it.`,
    `Intent: ${intent} — ${INTENT_GUIDE[intent]}`,
    `Tone: ${tone}. Language: ${language}. Plain text only (no HTML). Do not invent commitments, amounts or dates that are not in the email or the instructions.`,
    instructions ? `User instructions: ${instructions}` : "",
    "",
    formatEmail(slimEmail, undefined, budget.maxChars),
    threadBlock,
    "",
    "JSON schema:",
    DRAFT_JSON_SHAPE,
  ].join("\n");

  const request: LlmRequest = {
    useCase: "draft_reply",
    language,
    json: true,
    temperature: 0.4,
    messages: [
      { role: "system", content: SYSTEM_BASE(language) },
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

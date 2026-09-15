import type { DraftIntent, EmailContext, Language, ThreadContext } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { formatEmail, formatThread, SYSTEM_BASE } from "./format.js";

export const INTENT_GUIDE: Record<DraftIntent, string> = {
  accept: "Accept / agree with the request or proposal, confirm next steps.",
  decline: "Politely decline, give a short reason and, when possible, an alternative.",
  acknowledge: "Acknowledge receipt, say what will happen next and when.",
  follow_up: "Follow up on something outstanding (document, answer, decision) with a clear ask and a date.",
  request_info: "Ask for the missing information / documents, listed clearly.",
  custom: "Follow the user's instructions.",
};

export const DRAFT_JSON_SHAPE = `{"subject": "Re: ...", "body": "plain-text reply, greeting + 1-3 short paragraphs + sign-off placeholder", "language": "fr"|"en", "confidence": 0.0-1.0}`;

export function buildDraftReplyPrompt(input: { email: EmailContext; thread?: ThreadContext; intent: DraftIntent; tone: "formal" | "neutral" | "friendly"; instructions?: string; language: Language; senderName?: string }): LlmRequest {
  const { email, thread, intent, tone, instructions, language, senderName } = input;
  return {
    useCase: "draft_reply",
    language,
    json: true,
    temperature: 0.4,
    messages: [
      { role: "system", content: SYSTEM_BASE(language) },
      {
        role: "user",
        content: [
          `Write a reply DRAFT to the email below on behalf of ${senderName ?? "the recipient"}. The draft is never sent automatically; the user will edit it.`,
          `Intent: ${intent} — ${INTENT_GUIDE[intent]}`,
          `Tone: ${tone}. Language: ${language}. Plain text only (no HTML). Do not invent commitments, amounts or dates that are not in the email or the instructions.`,
          instructions ? `User instructions: ${instructions}` : "",
          "",
          formatEmail(email),
          thread ? `\n\nConversation context:\n${formatThread(thread, 10)}` : "",
          "",
          "JSON schema:",
          DRAFT_JSON_SHAPE,
        ].join("\n"),
      },
    ],
  };
}

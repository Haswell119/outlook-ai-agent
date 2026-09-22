import type { ChatMessage, EmailContext, Language, SearchSource } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { formatEmail, SYSTEM_BASE } from "./format.js";

export const CHAT_JSON_SHAPE = `{
  "headline": "short headline such as 'Client approval detected' (optional)",
  "answer": "the answer, citing sources inline as [1], [2] …",
  "sourceIds": [1, 2],
  "evidenceSourceId": 1,
  "quote": "verbatim sentence from the top source that supports the answer",
  "confidence": 0.0-1.0
}`;

export function formatSources(sources: SearchSource[]): string {
  return sources.map((s, i) => `[${i + 1}] Subject: ${s.subject} | From: ${s.from ?? "?"} | Date: ${s.date ?? "?"} | EmailId: ${s.emailId}\n${s.excerpt}`).join("\n\n");
}

export interface ChatPromptInput {
  question: string;
  sources: SearchSource[];
  history: ChatMessage[];
  currentEmail?: EmailContext;
  language: Language;
  /**
   * `conversation` (default): the opened email is the subject of the question
   * and is quoted in full. `mailbox`: the question is about the whole mailbox;
   * the opened email is at most one candidate among the sources, so it is only
   * named — quoting it in full made every answer about it.
   */
  scope?: "conversation" | "mailbox";
  /** Size of the user's index, told to the model so "nothing found" is honest. */
  indexedEmails?: number;
}

export function buildChatPrompt(input: ChatPromptInput): LlmRequest {
  const { question, sources, history, currentEmail, language, scope = "conversation", indexedEmails } = input;
  const mailboxWide = scope === "mailbox";
  const messages: LlmRequest["messages"] = [
    {
      role: "system",
      content: [
        SYSTEM_BASE(language),
        "You answer questions about the user's mailbox using ONLY the numbered sources provided.",
        "Cite every fact with its source number in square brackets, e.g. [2]. If the sources do not contain the answer, say so honestly and set sourceIds to [].",
        mailboxWide
          ? "The question is about the WHOLE mailbox, not about the email the user happens to have open: consider every source on its merits and never assume the question refers to the opened email unless it says so (\"this email\", \"ce mail\"…)."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    },
  ];
  for (const h of history.slice(-10)) messages.push({ role: h.role, content: h.content });
  const currentIdx = currentEmail ? sources.findIndex((s) => s.emailId === currentEmail.id) : -1;
  const context = !currentEmail
    ? ""
    : mailboxWide
      ? `Email currently opened in Outlook: "${currentEmail.subject}" from ${currentEmail.from?.name ?? currentEmail.from?.address ?? "?"}${currentIdx >= 0 ? ` (source [${currentIdx + 1}])` : " (not among the sources)"}.\n`
      : `Email currently opened in Outlook (context):\n${formatEmail(currentEmail)}\n`;
  const scopeLine = mailboxWide && typeof indexedEmails === "number" ? `Retrieval scope: the whole mailbox (${indexedEmails} indexed email${indexedEmails === 1 ? "" : "s"}).\n` : "";
  messages.push({
    role: "user",
    content: [
      context,
      scopeLine,
      sources.length ? `### SOURCES\n${formatSources(sources)}\n### END SOURCES` : "### SOURCES\n(no matching emails found)\n### END SOURCES",
      "",
      `Question: ${question}`,
      "",
      "JSON schema:",
      CHAT_JSON_SHAPE,
    ].join("\n"),
  });
  return { useCase: "chat_answer", language, json: true, temperature: 0.2, messages };
}

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

export function buildChatPrompt(input: { question: string; sources: SearchSource[]; history: ChatMessage[]; currentEmail?: EmailContext; language: Language }): LlmRequest {
  const { question, sources, history, currentEmail, language } = input;
  const messages: LlmRequest["messages"] = [
    {
      role: "system",
      content: [
        SYSTEM_BASE(language),
        "You answer questions about the user's mailbox using ONLY the numbered sources provided.",
        "Cite every fact with its source number in square brackets, e.g. [2]. If the sources do not contain the answer, say so honestly and set sourceIds to [].",
      ].join(" "),
    },
  ];
  for (const h of history.slice(-10)) messages.push({ role: h.role, content: h.content });
  messages.push({
    role: "user",
    content: [
      currentEmail ? `Email currently opened in Outlook (context):\n${formatEmail(currentEmail)}\n` : "",
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

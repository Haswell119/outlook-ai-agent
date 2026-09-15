import type { EmailContext, Language } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { formatEmail, SYSTEM_BASE } from "./format.js";

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

export function buildEmailAnalysisPrompt(email: EmailContext, lang: Language, thread?: EmailContext[]): LlmRequest {
  const threadBlock = thread && thread.length > 1 ? `\n\nEarlier messages of the conversation (context only, oldest first):\n${thread.slice(0, -1).map((m, i) => formatEmail(m, i + 1)).join("\n\n")}` : "";
  return {
    useCase: "email_analysis",
    language: lang,
    json: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_BASE(lang) },
      {
        role: "user",
        content: [
          "Analyse the following email for its recipient and produce the JSON below.",
          "Rules: risks are business/compliance/operational risks (deadlines, missing documents, confidentiality, urgency).",
          "Suggested actions: at most 5, only from the allowed types, with helpful parameters (e.g. {\"category\": \"...\"}, {\"title\": \"...\", \"dueDate\": \"YYYY-MM-DD\"}).",
          "Never suggest sending or deleting anything.",
          "",
          formatEmail(email),
          threadBlock,
          "",
          "JSON schema:",
          ANALYSIS_JSON_SHAPE,
        ].join("\n"),
      },
    ],
  };
}

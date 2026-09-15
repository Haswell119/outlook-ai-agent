import type { Language, ThreadContext } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { formatThread, SYSTEM_BASE } from "./format.js";

export const THREAD_JSON_SHAPE = `{
  "language": "fr" | "en",
  "executiveSummary": "3-4 sentences: context, current state, what is blocking, what is next",
  "missingDocuments": [{"name": "...", "requestedOn": "YYYY-MM-DD", "requestedFrom": "..."}],
  "decisions": ["..."],
  "openTasks": [{"title": "...", "owner": "...", "priority": "low|medium|high", "dueDate": "YYYY-MM-DD", "done": false, "critical": false}],
  "deadlines": [{"title": "...", "date": "YYYY-MM-DD", "description": "...", "atRisk": false}],
  "risks": [{"code": "snake_case", "title": "...", "description": "...", "severity": "low|medium|high"}],
  "recommendedActions": [{"type": "draft_reply|create_task|create_reminder|request_document|categorize|notify", "title": "...", "description": "...", "parameters": {}}],
  "recommendedNextStep": {"title": "...", "description": "...", "action": {"type": "draft_reply", "title": "...", "description": "...", "parameters": {}}},
  "confidence": 0.0-1.0
}`;

export function buildThreadSynthesisPrompt(thread: ThreadContext, lang: Language): LlmRequest {
  return {
    useCase: "thread_synthesis",
    language: lang,
    json: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_BASE(lang) },
      {
        role: "user",
        content: [
          "Synthesise the following email conversation for an operations / relationship manager.",
          "Identify explicitly: documents that were requested but not yet received, decisions, open tasks with owners, deadlines (flag those at risk), risks, and the single most useful next step.",
          "Mark exactly one open task as critical when something blocks the outcome.",
          "",
          formatThread(thread),
          "",
          "JSON schema:",
          THREAD_JSON_SHAPE,
        ].join("\n"),
      },
    ],
  };
}

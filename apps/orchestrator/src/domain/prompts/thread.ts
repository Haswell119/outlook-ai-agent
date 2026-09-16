import type { Language, ThreadContext } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import type { BuiltPrompt } from "./analysis.js";
import { estimateTokens, slimThread } from "./clean.js";
import { DEFAULT_BUDGET, formatEmail, SYSTEM_BASE, type PromptBudget } from "./format.js";

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

/**
 * Thread-synthesis prompt.
 *
 * A reply chain repeats the same text N times: message 12 quotes 11, which
 * quotes 10… Sending it verbatim is the single biggest waste of prompt tokens
 * in an email product. `slimThread` cleans every message, removes lines already
 * present in a more recent one, keeps the `threadMaxMessages` most recent and
 * replaces the rest with a one-line-per-message digest.
 */
export function buildThreadSynthesisPrompt(thread: ThreadContext, lang: Language, budget: PromptBudget = DEFAULT_BUDGET): BuiltPrompt {
  const slim = slimThread(thread.messages, { maxMessages: budget.threadMaxMessages, maxChars: budget.maxChars });
  const rendered = [`### THREAD "${thread.subject}" (${slim.messages.length} message${slim.messages.length > 1 ? "s" : ""} in full, oldest first${slim.droppedMessages ? `, ${slim.droppedMessages} older summarised` : ""})`, ...slim.messages.map((m, i) => formatEmail(m, i + 1, budget.maxChars))].join("\n\n");

  const content = [
    "Synthesise the following email conversation for an operations / relationship manager.",
    "Identify explicitly: documents that were requested but not yet received, decisions, open tasks with owners, deadlines (flag those at risk), risks, and the single most useful next step.",
    "Mark exactly one open task as critical when something blocks the outcome.",
    "Quoted history, signatures and legal footers have been removed; older messages appear only in the digest.",
    "",
    slim.digest,
    slim.digest ? "" : undefined,
    rendered,
    "",
    "JSON schema:",
    THREAD_JSON_SHAPE,
  ]
    .filter((l): l is string => l !== undefined && l !== "")
    .join("\n");

  const request: LlmRequest = {
    useCase: "thread_synthesis",
    language: lang,
    json: true,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_BASE(lang) },
      { role: "user", content },
    ],
  };
  return {
    request,
    stats: { rawChars: slim.originalChars, chars: slim.chars, tokens: estimateTokens(content), savedRatio: slim.savedRatio, droppedMessages: slim.droppedMessages },
  };
}

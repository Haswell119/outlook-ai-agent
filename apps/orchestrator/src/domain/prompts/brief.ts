import { z } from "zod";
import type { Language } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { estimateTokens } from "./clean.js";
import { SYSTEM_BASE } from "./format.js";

export const BRIEF_JSON_SHAPE = `{
  "headline": "one sentence, max 120 characters: the single thing that matters this morning",
  "highlights": ["3 to 6 bullets, each one short sentence, ordered by importance"],
  "confidence": 0.0-1.0
}`;

/** Only the headline and the bullets come from the model; every fact is precomputed. */
export const DailyBriefLlmSchema = z.object({
  headline: z.string().min(1),
  highlights: z.array(z.string().catch("")).catch([]).transform((a) => a.filter((s) => s.trim().length > 0).slice(0, 6)),
  confidence: z.coerce.number().min(0).max(1).catch(0.6),
});
export type DailyBriefLlm = z.infer<typeof DailyBriefLlmSchema>;

export interface BriefPromptInput {
  date: string;
  language: Language;
  /** Compact, already-computed facts: no email bodies reach this prompt. */
  facts: {
    newEmails: number;
    analysed: number;
    awaitingReply: number;
    phishingSuspected: number;
    priority: Array<{ subject: string; from?: string; reason: string; priority: string }>;
    tasks: string[];
    deadlines: Array<{ title: string; date?: string; atRisk: boolean }>;
    alerts: Array<{ title: string; severity: string }>;
  };
}

/**
 * The daily brief is assembled from precomputed analyses. The model only writes
 * the headline and the bullets from a compact fact sheet — one short call per
 * user per day (~400 prompt tokens), and it is skipped entirely when the model
 * is unavailable (the service falls back to a heuristic headline).
 */
export function buildDailyBriefPrompt(input: BriefPromptInput): { request: LlmRequest; tokens: number } {
  const { facts, language, date } = input;
  const line = (s: string) => `- ${s}`;
  const content = [
    `Write the morning brief for ${date}. Use ONLY the facts below — never invent an email, a name or a date.`,
    "Be direct and operational: what needs attention first, what is at risk, what can wait.",
    "",
    "### FACTS",
    `New emails since the previous brief: ${facts.newEmails} (analysed: ${facts.analysed}, awaiting a reply: ${facts.awaitingReply}, phishing suspected: ${facts.phishingSuspected})`,
    facts.priority.length ? `Priority emails:\n${facts.priority.map((p) => line(`[${p.priority}] ${p.subject}${p.from ? ` — ${p.from}` : ""}: ${p.reason}`)).join("\n")}` : "Priority emails: none",
    facts.tasks.length ? `Open tasks:\n${facts.tasks.map(line).join("\n")}` : "Open tasks: none",
    facts.deadlines.length ? `Deadlines:\n${facts.deadlines.map((d) => line(`${d.title}${d.date ? ` (${d.date})` : ""}${d.atRisk ? " — AT RISK" : ""}`)).join("\n")}` : "Deadlines: none",
    facts.alerts.length ? `Alerts:\n${facts.alerts.map((a) => line(`[${a.severity}] ${a.title}`)).join("\n")}` : "Alerts: none",
    "### END FACTS",
    "",
    "JSON schema:",
    BRIEF_JSON_SHAPE,
  ].join("\n");

  return {
    request: {
      useCase: "daily_brief",
      language,
      json: true,
      temperature: 0.3,
      maxTokens: 600,
      messages: [
        { role: "system", content: SYSTEM_BASE(language) },
        { role: "user", content },
      ],
    },
    tokens: estimateTokens(content),
  };
}

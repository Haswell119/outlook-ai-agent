import type { EmailContext, Language } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { formatEmail, SYSTEM_BASE } from "./format.js";

export const CLASSIFICATION_JSON_SHAPE = `{"category": "one of the categories", "confidence": 0.0-1.0, "reasons": ["short reasons"]}`;

export function buildClassificationPrompt(email: EmailContext, categories: string[], lang: Language): LlmRequest {
  return {
    useCase: "classification",
    language: lang,
    json: true,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_BASE(lang) },
      { role: "user", content: [`Classify the email into exactly one of these categories: ${categories.join(" | ")}.`, "", formatEmail(email), "", "JSON schema:", CLASSIFICATION_JSON_SHAPE].join("\n") },
    ],
  };
}

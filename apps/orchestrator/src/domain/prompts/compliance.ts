import type { ComposeContext, Language } from "@oao/shared";
import type { LlmRequest } from "../../ports/llm.js";
import { truncate } from "../../util/text.js";
import { SYSTEM_BASE } from "./format.js";

export const COMPLIANCE_JSON_SHAPE = `{"sensitive": true|false, "explanation": "one sentence explaining what is sensitive (or why not)", "categories": ["client identity", "portfolio data", "credentials", "personal data", "internal strategy"], "confidence": 0.0-1.0}`;

export function buildComplianceContentPrompt(draft: ComposeContext, externalRecipients: string[], lang: Language): LlmRequest {
  const attachments = draft.attachments.map((a) => `- ${a.name}${a.textContent ? `: ${truncate(a.textContent, 800)}` : ""}`).join("\n");
  return {
    useCase: "compliance_content",
    language: lang,
    json: true,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_BASE(lang) },
      {
        role: "user",
        content: [
          "You are the Compliance Guardian of a wealth manager. Decide whether this outgoing draft contains sensitive client information",
          "(client names linked to holdings, portfolio values or performance, account numbers, IBAN, personal identifiers, credentials, non-public internal strategy).",
          `External recipients: ${externalRecipients.length ? externalRecipients.join(", ") : "none"}.`,
          "",
          "### DRAFT",
          `Subject: ${draft.subject}`,
          `To: ${draft.to.map((r) => r.address).join(", ")}`,
          "Body:",
          truncate(draft.body, 6000),
          attachments ? `Attachments:\n${attachments}` : "Attachments: (none)",
          "### END DRAFT",
          "",
          "JSON schema:",
          COMPLIANCE_JSON_SHAPE,
        ].join("\n"),
      },
    ],
  };
}

import { emailDomain, isInternalAddress } from "@oao/shared";
import type { ComplianceIssue, ComplianceIssueCode, ComposeContext, Language, Policy, RiskLevel, SuggestedAction } from "@oao/shared";
import { compilePattern } from "../../util/text.js";
import { isFreeMailDomain, isLookalikeDomain } from "./lookalike.js";
import { maxRisk } from "../risk/governance.js";

/**
 * Pre-send compliance rules (Compliance Guardian). Pure functions over the
 * `ComposeContext` and the `Policy`; the LLM content check is added by the
 * service (see `sensitiveContentFromLlm`).
 */

export interface ComplianceEvaluation {
  issues: ComplianceIssue[];
  recommendedActions: SuggestedAction[];
  verdict: "allow" | "warn" | "block";
  /** Facts derived during evaluation, useful for the LLM prompt and the audit. */
  facts: {
    externalRecipients: string[];
    confidentialAttachments: string[];
    sensitiveMatches: Array<{ name: string; severity: RiskLevel; sample: string }>;
    hasSensitiveContent: boolean;
  };
}

const T = {
  external_recipient: { en: "External recipient detected", fr: "Destinataire externe détecté" },
  suspicious_recipient_domain: { en: "Suspicious recipient domain", fr: "Domaine de destinataire suspect" },
  confidential_attachment: { en: "Confidential attachment", fr: "Pièce jointe confidentielle" },
  missing_classification_label: { en: "Missing classification label", fr: "Étiquette de classification manquante" },
  sensitive_client_information: { en: "Sensitive client information found", fr: "Informations client sensibles détectées" },
  large_distribution: { en: "Large distribution list", fr: "Diffusion large" },
  reply_all_external: { en: "Reply-all with external recipients", fr: "Répondre à tous avec des destinataires externes" },
  policy_violation: { en: "Policy violation", fr: "Violation de politique" },
} as const satisfies Record<ComplianceIssueCode, { en: string; fr: string }>;

let issueSeq = 0;
const issue = (code: ComplianceIssueCode, severity: RiskLevel, description: string, lang: Language, subject?: string): ComplianceIssue => ({
  id: `${code}-${++issueSeq}`,
  code,
  title: T[code][lang],
  description,
  severity,
  subject,
});

/** Reset the issue id counter (tests). */
export const resetIssueIds = () => {
  issueSeq = 0;
};

export function allRecipients(draft: ComposeContext): string[] {
  return [...draft.to, ...draft.cc, ...draft.bcc].map((r) => r.address.trim().toLowerCase()).filter(Boolean);
}

export function externalRecipients(draft: ComposeContext, policy: Policy): string[] {
  return allRecipients(draft).filter((a) => !isInternalAddress(a, policy.internalDomains));
}

export function findConfidentialAttachments(draft: ComposeContext, policy: Policy): string[] {
  const patterns = policy.confidentialPatterns.map((p) => p.toLowerCase()).filter(Boolean);
  if (!patterns.length) return [];
  return draft.attachments
    .filter((a) => {
      const hay = `${a.name} ${a.textContent ?? ""}`.toLowerCase();
      return patterns.some((p) => hay.includes(p));
    })
    .map((a) => a.name);
}

export function findSensitiveData(text: string, policy: Policy): Array<{ name: string; severity: RiskLevel; sample: string }> {
  const matches: Array<{ name: string; severity: RiskLevel; sample: string }> = [];
  for (const p of policy.sensitiveDataPatterns) {
    const re = compilePattern(p.pattern);
    if (!re) continue;
    const m = re.exec(text);
    if (m) matches.push({ name: p.name, severity: p.severity, sample: m[0].slice(0, 40) });
  }
  return matches;
}

export interface ComplianceRuleOptions {
  language: Language;
  /** Result of the optional LLM content analysis (added by the service). */
  llmSensitive?: { sensitive: boolean; explanation: string; confidence: number };
}

export function evaluateCompliance(draft: ComposeContext, policy: Policy, opts: ComplianceRuleOptions): ComplianceEvaluation {
  const lang = opts.language;
  const issues: ComplianceIssue[] = [];
  const external = externalRecipients(draft, policy);
  const confidentialAttachments = findConfidentialAttachments(draft, policy);
  const attachmentText = draft.attachments.map((a) => `${a.name}\n${a.textContent ?? ""}`).join("\n");
  const sensitiveMatches = findSensitiveData(`${draft.subject}\n${draft.body}\n${attachmentText}`, policy);
  const hasSensitiveContent = sensitiveMatches.length > 0 || confidentialAttachments.length > 0 || opts.llmSensitive?.sensitive === true;

  // 1. external_recipient
  if (external.length) {
    const severity: RiskLevel = draft.attachments.length > 0 || hasSensitiveContent ? "high" : "medium";
    const desc =
      lang === "fr"
        ? `${external[0]}${external.length > 1 ? ` (+${external.length - 1})` : ""} est en dehors de votre organisation.`
        : `${external[0]}${external.length > 1 ? ` (+${external.length - 1})` : ""} is outside your organization.`;
    issues.push(issue("external_recipient", severity, desc, lang, external.join(", ")));
  }

  // 2. suspicious_recipient_domain
  for (const address of allRecipients(draft)) {
    const domain = emailDomain(address);
    if (isLookalikeDomain(domain, policy.internalDomains)) {
      issues.push(
        issue(
          "suspicious_recipient_domain",
          "high",
          lang === "fr" ? `Le domaine ${domain} ressemble à un domaine interne (possible usurpation).` : `Domain ${domain} looks like an internal domain (possible lookalike).`,
          lang,
          address,
        ),
      );
    } else if (isFreeMailDomain(domain) && hasSensitiveContent) {
      issues.push(
        issue(
          "suspicious_recipient_domain",
          "medium",
          lang === "fr" ? `${address} utilise une messagerie grand public (${domain}) pour du contenu sensible.` : `${address} uses a free-mail provider (${domain}) for sensitive content.`,
          lang,
          address,
        ),
      );
    }
  }

  // 3. confidential_attachment
  for (const name of confidentialAttachments) {
    issues.push(
      issue(
        "confidential_attachment",
        external.length ? "high" : "medium",
        lang === "fr" ? `${name} est classé comme confidentiel.` : `${name} is classified as confidential.`,
        lang,
        name,
      ),
    );
  }

  // 4. missing_classification_label
  if (policy.requiredClassificationLabels.length > 0) {
    const label = draft.sensitivityLabel?.trim();
    const accepted = policy.requiredClassificationLabels.map((l) => l.toLowerCase());
    if (!label || !accepted.includes(label.toLowerCase())) {
      issues.push(
        issue(
          "missing_classification_label",
          "medium",
          lang === "fr" ? "Cet email n'est pas étiqueté. La politique exige une classification." : "This email is not labeled. Policy requires a classification.",
          lang,
        ),
      );
    }
  }

  // 5. sensitive_client_information
  if (sensitiveMatches.length) {
    const severity = maxRisk(...sensitiveMatches.map((m) => m.severity));
    const names = Array.from(new Set(sensitiveMatches.map((m) => m.name))).join(", ");
    issues.push(
      issue(
        "sensitive_client_information",
        severity,
        lang === "fr" ? `Le contenu contient des données sensibles (${names}).` : `Content contains sensitive data (${names}).`,
        lang,
        names,
      ),
    );
  } else if (opts.llmSensitive?.sensitive) {
    issues.push(
      issue(
        "sensitive_client_information",
        "high",
        opts.llmSensitive.explanation || (lang === "fr" ? "Le contenu peut contenir des informations client ou portefeuille sensibles." : "Content may contain sensitive client or portfolio information."),
        lang,
      ),
    );
  }

  // 6. large_distribution
  if (external.length >= policy.largeDistributionThreshold) {
    issues.push(
      issue(
        "large_distribution",
        "medium",
        lang === "fr" ? `${external.length} destinataires externes (seuil : ${policy.largeDistributionThreshold}).` : `${external.length} external recipients (threshold: ${policy.largeDistributionThreshold}).`,
        lang,
      ),
    );
  }

  // 7. reply_all_external
  if (draft.isReplyAll && external.length) {
    issues.push(
      issue(
        "reply_all_external",
        "medium",
        lang === "fr" ? "Répondre à tous inclut des destinataires externes." : "Reply-all includes external recipients.",
        lang,
      ),
    );
  }

  const recommendedActions = recommendActions(issues, draft, policy, lang);
  const hasHigh = issues.some((i) => i.severity === "high");
  const verdict: ComplianceEvaluation["verdict"] = issues.length === 0 ? "allow" : hasHigh && policy.blockOnHighRisk ? "block" : "warn";

  return { issues, recommendedActions, verdict, facts: { externalRecipients: external, confidentialAttachments, sensitiveMatches, hasSensitiveContent } };
}

function recommendActions(issues: ComplianceIssue[], draft: ComposeContext, policy: Policy, lang: Language): SuggestedAction[] {
  const codes = new Set(issues.map((i) => i.code));
  const actions: SuggestedAction[] = [];
  const hasHigh = issues.some((i) => i.severity === "high");
  if (codes.has("missing_classification_label") || codes.has("sensitive_client_information") || codes.has("confidential_attachment")) {
    const label = policy.requiredClassificationLabels.find((l) => /confidential|confidentiel/i.test(l)) ?? policy.requiredClassificationLabels[0] ?? "Confidential";
    actions.push({
      type: "apply_label",
      title: lang === "fr" ? `Appliquer l'étiquette « ${label} »` : `Apply "${label}" label`,
      description: lang === "fr" ? "Classifier l'email avant l'envoi." : "Classify the email before sending.",
      parameters: { label },
    });
  }
  if (codes.has("confidential_attachment")) {
    const names = issues.filter((i) => i.code === "confidential_attachment").map((i) => i.subject).filter(Boolean);
    const ids = draft.attachments.filter((a) => names.includes(a.name)).map((a) => a.id).filter(Boolean);
    actions.push({
      type: "remove_attachment",
      title: lang === "fr" ? "Retirer la pièce jointe" : "Remove attachment",
      description: lang === "fr" ? `Retirer ${names.join(", ")} avant l'envoi externe.` : `Remove ${names.join(", ")} before sending externally.`,
      parameters: { attachmentNames: names, attachmentIds: ids },
    });
  }
  if (hasHigh || codes.has("external_recipient")) {
    actions.push({
      type: "request_approval",
      title: lang === "fr" ? "Demander une approbation" : "Request approval",
      description: lang === "fr" ? "Demander l'approbation d'un manager ou d'un compliance officer." : "Request approval from a manager or compliance officer.",
      parameters: {},
    });
  }
  if (hasHigh) {
    actions.push({
      type: "escalate_compliance",
      title: lang === "fr" ? "Envoyer pour revue compliance" : "Send for compliance review",
      description: lang === "fr" ? "Créer une escalade auprès de l'équipe Compliance." : "Create an escalation for the Compliance team.",
      parameters: { issueCodes: Array.from(codes) },
    });
  }
  return actions;
}

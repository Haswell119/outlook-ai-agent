import type { Automation, Language } from "@oao/shared";
import { emailDomain } from "@oao/shared";

/**
 * Dry-run of an automation against a sample of the user's emails.
 * No side effects: it only reports what would happen.
 */
export interface SimulationEmail {
  emailId: string;
  subject: string;
  fromAddress?: string;
  hasAttachments?: boolean;
  attachmentNames?: string[];
  categories?: string[];
}

export type Simulation = NonNullable<Automation["lastSimulation"]>;

const CHECK_NAMES = {
  attachment: { en: "Attachment detection accuracy", fr: "Précision de la détection des pièces jointes" },
  folder: { en: "Correct folder mapping", fr: "Dossier de destination correct" },
  category: { en: "Category assignment", fr: "Attribution de la catégorie" },
  reminder: { en: "Reminder creation", fr: "Création du rappel" },
} as const;

export function matchesTrigger(trigger: Automation["trigger"], email: SimulationEmail): boolean {
  const c = trigger.conditions;
  const from = (email.fromAddress ?? "").toLowerCase();
  if (c.fromAddress && from !== c.fromAddress.toLowerCase()) return false;
  if (c.fromDomain) {
    const d = emailDomain(from);
    if (!(d === c.fromDomain.toLowerCase() || d.endsWith(`.${c.fromDomain.toLowerCase()}`))) return false;
  }
  if (c.subjectContains && !email.subject.toLowerCase().includes(c.subjectContains.toLowerCase())) return false;
  if (c.hasAttachments !== undefined && Boolean(email.hasAttachments) !== c.hasAttachments) return false;
  if (c.attachmentTypes?.length) {
    const names = (email.attachmentNames ?? []).map((n) => n.toLowerCase());
    if (!c.attachmentTypes.some((t) => names.some((n) => n.endsWith(t.toLowerCase())))) return false;
  }
  return true;
}

export function simulateAutomation(automation: Pick<Automation, "trigger" | "steps">, emails: SimulationEmail[], lang: Language, runAt = new Date().toISOString()): Simulation {
  const results = emails.map((email) => {
    const wouldApply = matchesTrigger(automation.trigger, email);
    const stepsPreview = wouldApply ? automation.steps.map((s) => previewStep(s, email, lang)) : [];
    return { emailId: email.emailId, subject: email.subject, wouldApply, stepsPreview };
  });
  const applied = results.filter((r) => r.wouldApply).length;
  const stepTypes = new Set(automation.steps.map((s) => s.type));
  const checks: Simulation["checks"] = [];

  if (stepTypes.has("detect_attachment") || stepTypes.has("save_attachment")) {
    const withAtt = emails.filter((e) => e.hasAttachments).length;
    const matchedWithAtt = results.filter((r, i) => r.wouldApply && emails[i]?.hasAttachments).length;
    const passed = applied === 0 || matchedWithAtt === applied;
    checks.push({ name: CHECK_NAMES.attachment[lang], passed, detail: `${matchedWithAtt}/${applied} ${lang === "fr" ? "emails concernés ont une pièce jointe" : "matched emails carry an attachment"} (${withAtt} ${lang === "fr" ? "dans l'échantillon" : "in sample"})` });
  }
  if (stepTypes.has("move_to_folder") || stepTypes.has("save_attachment") || stepTypes.has("archive")) {
    const step = automation.steps.find((s) => s.type === "move_to_folder" || s.type === "save_attachment" || s.type === "archive");
    const folder = step?.parameters.folder ?? step?.parameters.destinationFolder ?? step?.parameters.path;
    const passed = step?.type === "archive" || (typeof folder === "string" && folder.length > 0);
    checks.push({ name: CHECK_NAMES.folder[lang], passed, detail: passed ? String(folder ?? "Archive") : lang === "fr" ? "Aucun dossier configuré" : "No folder configured" });
  }
  if (stepTypes.has("categorize") || stepTypes.has("classify_email") || stepTypes.has("apply_label")) {
    const step = automation.steps.find((s) => s.type === "categorize" || s.type === "classify_email" || s.type === "apply_label");
    const category = step?.parameters.category ?? step?.parameters.label ?? (step?.parameters.categories as string[] | undefined)?.[0];
    const passed = typeof category === "string" && category.length > 0;
    checks.push({ name: CHECK_NAMES.category[lang], passed, detail: passed ? String(category) : lang === "fr" ? "Aucune catégorie configurée" : "No category configured" });
  }
  if (stepTypes.has("create_reminder") || stepTypes.has("create_task") || stepTypes.has("flag")) {
    checks.push({ name: CHECK_NAMES.reminder[lang], passed: true, detail: lang === "fr" ? `${applied} rappel(s) seraient créés` : `${applied} reminder(s) would be created` });
  }
  return { runAt, sampleSize: emails.length, checks, results };
}

function previewStep(step: Automation["steps"][number], email: SimulationEmail, lang: Language): string {
  const p = step.parameters;
  switch (step.type) {
    case "detect_attachment":
      return lang === "fr" ? `Pièce(s) jointe(s) détectée(s) : ${(email.attachmentNames ?? []).join(", ") || "—"}` : `Attachment(s) detected: ${(email.attachmentNames ?? []).join(", ") || "—"}`;
    case "save_attachment":
      return lang === "fr" ? `Enregistrer ${(email.attachmentNames ?? []).join(", ") || "la pièce jointe"} dans ${p.folder ?? p.path ?? "…"}` : `Save ${(email.attachmentNames ?? []).join(", ") || "attachment"} to ${p.folder ?? p.path ?? "…"}`;
    case "categorize":
    case "classify_email":
      return lang === "fr" ? `Catégoriser « ${email.subject} » en ${p.category ?? "…"}` : `Categorize "${email.subject}" as ${p.category ?? "…"}`;
    case "move_to_folder":
      return lang === "fr" ? `Déplacer vers ${p.folder ?? p.destinationFolder ?? "…"}` : `Move to ${p.folder ?? p.destinationFolder ?? "…"}`;
    case "create_reminder":
    case "create_task":
      return lang === "fr" ? `Créer un rappel : ${p.title ?? `Traiter « ${email.subject} »`}` : `Create reminder: ${p.title ?? `Review "${email.subject}"`}`;
    default:
      return `${step.title}`;
  }
}

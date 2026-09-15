import type { EmailContext, Language, SuggestedAction } from "@oao/shared";
import { extractDates, normalizeWhitespace, truncate } from "../../util/text.js";
import { detectLanguage } from "../language.js";

/**
 * Keyword heuristics over an email. Used by:
 *  - the deterministic mock LLM provider (demo / tests),
 *  - the degraded fallback when the real model is down or returns invalid JSON.
 * The output mirrors the raw JSON expected from the model (see prompts/schemas.ts).
 */

export interface HeuristicAnalysis {
  language: Language;
  summary: string;
  decisions: string[];
  pendingTasks: string[];
  risks: Array<{ code: string; title: string; description?: string; severity: "low" | "medium" | "high" }>;
  suggestedActions: SuggestedAction[];
  quickReplies: string[];
  classification: { category: string; confidence: number };
  confidence: number;
  signals: Signals;
}

export interface Signals {
  approval: boolean;
  request: boolean;
  deadline: boolean;
  urgent: boolean;
  attachment: boolean;
  confidential: boolean;
  mandate: boolean;
  missingDocument: boolean;
  meeting: boolean;
  question: boolean;
  dates: string[];
  keyPhrases: string[];
}

const KW = {
  approval: ["approve", "approved", "approval", "confirm", "confirmed", "we confirm", "agree", "sign-off", "signed off", "green light", "approuv", "confirm", "validé", "valid", "accord", "feu vert"],
  request: ["please", "could you", "can you", "would you", "kindly", "need", "require", "merci de", "pourriez-vous", "pouvez-vous", "veuillez", "besoin", "nous attendons", "we need", "send us", "provide"],
  deadline: ["deadline", "due", "by end of", "by friday", "by monday", "no later than", "target date", "before", "échéance", "délai", "au plus tard", "avant le", "d'ici", "date limite", "date cible"],
  urgent: ["urgent", "asap", "immediately", "critical", "as soon as possible", "time-sensitive", "urgence", "immédiatement", "critique", "dès que possible", "prioritaire"],
  attachment: ["attached", "attachment", "enclosed", "ci-joint", "pièce jointe", "pj", "en annexe", "find attached", "veuillez trouver"],
  confidential: ["confidential", "confidentiel", "internal only", "do not forward", "sensitive", "sensible", "restricted", "private", "privé", "ne pas diffuser"],
  mandate: ["mandate", "mandat", "kyc", "onboarding", "investment management agreement", "ima", "account opening", "ouverture de compte", "portfolio", "portefeuille"],
  missingDocument: ["missing", "outstanding", "still waiting", "not yet received", "haven't received", "have not received", "manquant", "en attente", "toujours pas reçu", "pas encore reçu", "reste à fournir", "pending signature", "à signer", "unsigned"],
  meeting: ["meeting", "call", "réunion", "rendez-vous", "visio", "teams", "conference", "appel"],
};

const has = (lower: string, list: string[]) => list.some((k) => lower.includes(k));

export function extractSignals(email: Pick<EmailContext, "subject" | "body" | "attachments">): Signals {
  const text = `${email.subject}\n${email.body}`;
  const lower = text.toLowerCase();
  const sentences = normalizeWhitespace(email.body)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
  const keyPhrases = sentences.filter((s) => {
    const l = s.toLowerCase();
    return has(l, KW.approval) || has(l, KW.request) || has(l, KW.deadline) || has(l, KW.missingDocument) || has(l, KW.urgent);
  });
  return {
    approval: has(lower, KW.approval),
    request: has(lower, KW.request),
    deadline: has(lower, KW.deadline) || extractDates(text).length > 0,
    urgent: has(lower, KW.urgent),
    attachment: email.attachments.length > 0 || has(lower, KW.attachment),
    confidential: has(lower, KW.confidential),
    mandate: has(lower, KW.mandate),
    missingDocument: has(lower, KW.missingDocument),
    meeting: has(lower, KW.meeting),
    question: /\?/.test(email.body),
    dates: extractDates(text).slice(0, 5),
    keyPhrases: keyPhrases.slice(0, 6),
  };
}

export function classify(email: Pick<EmailContext, "subject" | "body" | "attachments">, lang: Language): { category: string; confidence: number } {
  const lower = `${email.subject}\n${email.body}`.toLowerCase();
  const rules: Array<[RegExp, string, string]> = [
    [/mandate|mandat|kyc|onboarding|ima\b/, "Client mandate", "Mandat client"],
    [/invoice|facture|payment|paiement|virement|wire/, "Finance / Payment", "Finance / Paiement"],
    [/compliance|conformité|audit|regulat|finma|réglement/, "Compliance", "Compliance"],
    [/report|rapport|performance|reporting|statement|relevé/, "Client reporting", "Reporting client"],
    [/meeting|réunion|call|rendez-vous|agenda|invitation/, "Meeting", "Réunion"],
    [/contract|contrat|agreement|legal|juridique|signature/, "Legal", "Juridique"],
    [/newsletter|unsubscribe|désabonner|webinar|promotion/, "Newsletter", "Newsletter"],
  ];
  for (const [re, en, fr] of rules) if (re.test(lower)) return { category: lang === "fr" ? fr : en, confidence: 0.8 };
  return { category: lang === "fr" ? "Général" : "General", confidence: 0.5 };
}

export function analyzeHeuristically(email: EmailContext, preferred?: Language, confidence = 0.3): HeuristicAnalysis {
  const language = preferred ?? detectLanguage(`${email.subject}\n${email.body}`, "en");
  const fr = language === "fr";
  const s = extractSignals(email);
  const sender = email.from?.name || email.from?.address || (fr ? "L'expéditeur" : "The sender");
  const subject = email.subject || (fr ? "(sans objet)" : "(no subject)");
  const firstSentences = normalizeWhitespace(email.body)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 20 && !/^(bonjour|hello|hi|dear|cher|chère)/i.test(x))
    .slice(0, 2)
    .join(" ");

  const topic = fr ? `au sujet de « ${subject} »` : `regarding "${subject}"`;
  let summary = fr ? `${sender} écrit ${topic}.` : `${sender} writes ${topic}.`;
  if (firstSentences) summary += ` ${truncate(firstSentences, 260)}`;
  if (s.approval) summary += fr ? " Une approbation ou confirmation est exprimée." : " An approval or confirmation is expressed.";
  if (s.missingDocument) summary += fr ? " Un élément reste en attente." : " Something is still outstanding.";
  if (s.deadline && s.dates[0]) summary += fr ? ` Échéance mentionnée : ${s.dates[0]}.` : ` Deadline mentioned: ${s.dates[0]}.`;

  const decisions: string[] = [];
  if (s.approval) decisions.push(fr ? `Approbation / confirmation communiquée par ${sender}.` : `Approval / confirmation communicated by ${sender}.`);
  for (const p of s.keyPhrases.filter((k) => /approv|confirm|agree|valid|accord/i.test(k)).slice(0, 2)) decisions.push(truncate(p, 160));

  const pendingTasks: string[] = [];
  if (s.attachment) pendingTasks.push(fr ? "Examiner la ou les pièces jointes." : "Review the attached document(s).");
  if (s.request) pendingTasks.push(fr ? `Répondre à la demande de ${sender}.` : `Respond to ${sender}'s request.`);
  if (s.missingDocument) pendingTasks.push(fr ? "Obtenir le document ou l'information manquante." : "Obtain the missing document or information.");
  if (s.meeting) pendingTasks.push(fr ? "Confirmer la réunion / le créneau proposé." : "Confirm the proposed meeting / slot.");
  if (s.question && !s.request) pendingTasks.push(fr ? "Répondre aux questions posées." : "Answer the questions raised.");
  for (const p of s.keyPhrases.filter((k) => /please|could you|merci de|veuillez|pourriez/i.test(k)).slice(0, 2)) pendingTasks.push(truncate(p, 160));

  const risks: HeuristicAnalysis["risks"] = [];
  if (s.urgent) risks.push({ code: "urgency", title: fr ? "Demande urgente" : "Urgent request", severity: "medium", description: fr ? "Le message contient des marqueurs d'urgence." : "The message contains urgency markers." });
  if (s.deadline) risks.push({ code: "deadline", title: fr ? "Échéance à respecter" : "Deadline to meet", severity: s.urgent ? "high" : "medium", description: s.dates[0] ? (fr ? `Date mentionnée : ${s.dates[0]}` : `Date mentioned: ${s.dates[0]}`) : undefined });
  if (s.missingDocument) risks.push({ code: "missing_document", title: fr ? "Document ou information manquante" : "Missing document or information", severity: "medium" });
  if (s.confidential) risks.push({ code: "confidential_content", title: fr ? "Contenu confidentiel" : "Confidential content", severity: "medium", description: fr ? "Ne pas transférer sans validation." : "Do not forward without validation." });
  if (s.mandate && s.confidential) risks.push({ code: "compliance_exposure", title: fr ? "Exposition compliance potentielle" : "Potential compliance exposure", severity: "medium" });

  const suggestedActions: SuggestedAction[] = [];
  if (s.request || s.question || s.approval) suggestedActions.push({ type: "draft_reply", title: fr ? "Rédiger une réponse" : "Draft reply", description: fr ? "Générer un brouillon de réponse avec l'IA" : "Generate a reply draft using AI", parameters: { intent: s.approval ? "acknowledge" : "custom" } });
  if (s.deadline || s.urgent || s.attachment) suggestedActions.push({ type: "create_reminder", title: fr ? "Créer un rappel" : "Create reminder", description: fr ? "Planifier un suivi de cet email" : "Set a follow-up to review this email", parameters: { title: `${fr ? "Suivi" : "Follow-up"}: ${subject}`, ...(s.dates[0] ? { dueDate: s.dates[0] } : {}) } });
  const cls = classify(email, language);
  suggestedActions.push({ type: "classify_email", title: fr ? "Classer l'email" : "Classify email", description: fr ? `Catégoriser comme « ${cls.category} »` : `Categorize as "${cls.category}"`, parameters: { category: cls.category } });
  if (s.missingDocument) suggestedActions.push({ type: "request_document", title: fr ? "Demander le document" : "Request document", description: fr ? "Ouvrir un brouillon demandant l'élément manquant" : "Open a draft asking for the missing item", parameters: {} });
  if (s.confidential && s.attachment) suggestedActions.push({ type: "escalate_compliance", title: fr ? "Escalader à la compliance" : "Escalate compliance review", description: fr ? "Transmettre à la compliance pour revue" : "Route to compliance for further review", parameters: {} });
  if (s.mandate) suggestedActions.push({ type: "categorize", title: fr ? "Taguer « Mandat client »" : "Tag as client mandate", description: fr ? "Ajouter la catégorie Mandat client" : "Add the Client mandate category", parameters: { category: fr ? "Mandat client" : "Client mandate" } });

  const quickReplies = fr
    ? [s.attachment ? "Bien reçu, je regarde et reviens vers vous." : "Merci, bien noté.", s.request ? "Pouvez-vous préciser les points prioritaires ?" : "Pouvons-nous en discuter plus tard aujourd'hui ?", s.deadline ? "Nous respecterons l'échéance indiquée." : "Je vous confirme dès que possible."]
    : [s.attachment ? "Looks good, I will review." : "Thanks, noted.", s.request ? "Please highlight the high-priority items." : "Can we discuss this later today?", s.deadline ? "We will meet the stated deadline." : "I will confirm as soon as possible."];

  return { language, summary, decisions, pendingTasks, risks, suggestedActions, quickReplies: quickReplies.slice(0, 3), classification: cls, confidence, signals: s };
}

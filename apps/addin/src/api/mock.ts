/**
 * In-browser mock of the orchestrator (VITE_API_MOCK=true, `?mock=1`, or automatic
 * fallback when the backend health check fails in dev/preview). Responses follow the
 * mock-ups in docs/mockups.md and are validated against the shared schemas.
 */
import {
  ActionProposalSchema,
  ApproveActionsResponseSchema,
  AutomationSchema,
  ChatResponseSchema,
  ComplianceCheckResponseSchema,
  DraftReplySchema,
  EmailAnalysisSchema,
  EscalationSchema,
  HealthSchema,
  IndexEmailsResponseSchema,
  ThreadSynthesisSchema,
  type ActionProposal,
  type ActionResult,
  type Automation,
  type ChatResponse,
  type ComplianceCheckResponse,
  type ComplianceIssue,
  type EmailAnalysis,
  type Language,
  type ProposedAction,
  type ThreadSynthesis,
} from "@oao/shared";
import type { z, ZodType } from "zod";
import type { OaoApi } from "./types";

const MODEL = "qwen3-30b-a3b";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 1;
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
const now = () => new Date().toISOString();

function L<T>(lang: Language, en: T, fr: T): T {
  return lang === "fr" ? fr : en;
}

function validate<T>(schema: ZodType<T, z.ZodTypeDef, unknown>, data: unknown, label: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    console.error(`[oao mock] fixture ${label} does not match the shared schema`, r.error.issues);
    return data as T;
  }
  return r.data;
}

/* ----------------------------------------------------------------- fixtures */

export function mockAnalysis(lang: Language, emailId: string, phishing = false): EmailAnalysis {
  return {
    emailId,
    language: lang,
    summary: L(
      lang,
      "Sarah Johnson is sharing the Q2 vendor risk assessment report for review. There are high-risk findings that require your input and approval.",
      "Sarah Johnson partage le rapport d'évaluation des risques fournisseurs du T2 pour revue. Des constats à risque élevé nécessitent votre avis et votre approbation.",
    ),
    decisions: [
      L(lang, "Review and approve high-risk findings in the Q2 vendor risk assessment.", "Examiner et approuver les constats à risque élevé de l'évaluation T2."),
    ],
    pendingTasks: [
      L(lang, "Review attached Q2 vendor risk assessment.", "Examiner l'évaluation des risques fournisseurs T2 jointe."),
      L(lang, "Provide input or approval on high-risk findings.", "Donner un avis ou une approbation sur les constats à risque élevé."),
    ],
    risks: [
      { code: "high_risk_vendor", title: L(lang, "High-risk vendor findings identified.", "Constats fournisseurs à risque élevé identifiés."), severity: "high" },
      { code: "compliance_exposure", title: L(lang, "Potential compliance and operational exposure.", "Exposition potentielle en matière de conformité et d'opérations."), severity: "medium" },
      { code: "approval_pending", title: L(lang, "Approval pending from recipient.", "Approbation en attente du destinataire."), severity: "low" },
    ],
    suggestedActions: [
      { type: "create_reminder", title: L(lang, "Create reminder", "Créer un rappel"), description: L(lang, "Set a follow-up to review this email", "Planifier un suivi pour cet email"), parameters: {} },
      { type: "draft_reply", title: L(lang, "Draft reply", "Rédiger une réponse"), description: L(lang, "Generate a reply draft using AI", "Générer un brouillon de réponse avec l'IA"), parameters: { intent: "acknowledge" } },
      { type: "classify_email", title: L(lang, "Classify email", "Classer l'email"), description: L(lang, "Categorize this email", "Catégoriser cet email"), parameters: { category: "Client A – Reporting" } },
      { type: "escalate_compliance", title: L(lang, "Escalate compliance review", "Escalader à la Compliance"), description: L(lang, "Route to compliance for further review", "Transmettre à la Compliance pour examen"), parameters: {} },
    ],
    quickReplies: L(
      lang,
      ["Looks good, I will review.", "Please highlight the high-risk items.", "Can we discuss this later today?"],
      ["Très bien, je vais examiner.", "Merci de mettre en évidence les points à risque élevé.", "Pouvons-nous en discuter plus tard aujourd'hui ?"],
    ),
    classification: { category: L(lang, "Client onboarding / Vendor risk", "Onboarding client / Risque fournisseur"), confidence: 0.88 },
    confidence: 0.92,
    phishing: phishing
      ? { score: 0.81, verdict: "likely_phishing", indicators: [L(lang, "Sender domain mismatch", "Domaine expéditeur incohérent"), L(lang, "Urgent payment request", "Demande de paiement urgente")] }
      : { score: 0.04, verdict: "clean", indicators: [] },
    auditId: id("aud"),
    generatedAt: now(),
    model: MODEL,
  };
}

export function mockThread(lang: Language, conversationId: string): ThreadSynthesis {
  return {
    conversationId,
    language: lang,
    executiveSummary: L(
      lang,
      "This conversation covers the onboarding of ABC Capital for the Project Horizon mandate. ABC has provided most required information, but one critical document is still outstanding. The target onboarding date is approaching.",
      "Cette conversation concerne l'onboarding d'ABC Capital pour le mandat Project Horizon. ABC a fourni la plupart des informations requises, mais un document critique manque toujours. La date cible d'onboarding approche.",
    ),
    missingDocuments: [{ name: L(lang, "Signed Account Mandate", "Mandat de compte signé"), requestedOn: "2025-05-14", requestedFrom: "ABC Capital" }],
    decisions: [
      L(lang, "Proceed with onboarding once the signed Account Mandate is received.", "Poursuivre l'onboarding dès réception du mandat de compte signé."),
      L(lang, "KYC validation to be completed by the Compliance Team.", "Validation KYC à finaliser par l'équipe Compliance."),
    ],
    openTasks: [
      { title: L(lang, "Obtain signed Account Mandate from ABC Capital", "Obtenir le mandat de compte signé d'ABC Capital"), owner: "Jane Smith", priority: "high", done: false, critical: true },
      { title: L(lang, "Complete KYC validation", "Finaliser la validation KYC"), owner: L(lang, "Compliance Team", "Équipe Compliance"), priority: "medium", done: false, critical: false },
      { title: L(lang, "Legal final sign-off", "Validation finale Legal"), owner: L(lang, "Legal Team", "Équipe Legal"), priority: "medium", done: false, critical: false },
    ],
    deadlines: [
      { title: L(lang, "Target onboarding date", "Date cible d'onboarding"), date: "2025-05-30", description: L(lang, "30 May 2025 (in 5 days)", "30 mai 2025 (dans 5 jours)"), atRisk: true },
      { title: L(lang, "Risk of delay if missing document not received.", "Risque de retard si le document manquant n'est pas reçu."), atRisk: true },
    ],
    risks: [
      { code: "missing_document", title: L(lang, "Onboarding blocked by the missing Account Mandate.", "Onboarding bloqué par le mandat de compte manquant."), severity: "high" },
      { code: "kyc_pending", title: L(lang, "KYC validation not yet completed.", "Validation KYC pas encore terminée."), severity: "medium" },
    ],
    recommendedActions: [
      { type: "draft_reply", title: L(lang, "Draft follow-up", "Rédiger une relance"), description: L(lang, "Email ABC Capital", "Écrire à ABC Capital"), parameters: { intent: "follow_up" } },
      { type: "create_task", title: L(lang, "Create task", "Créer une tâche"), description: L(lang, "Add to your task list", "Ajouter à votre liste de tâches"), parameters: {} },
      { type: "create_reminder", title: L(lang, "Set reminder", "Définir un rappel"), description: L(lang, "For document follow-up", "Pour le suivi du document"), parameters: {} },
      { type: "notify", title: L(lang, "Share summary", "Partager la synthèse"), description: L(lang, "Copy summary or send", "Copier ou envoyer la synthèse"), parameters: {} },
    ],
    recommendedNextStep: {
      title: L(lang, "Draft a follow-up email to request the signed Account Mandate.", "Rédiger une relance pour demander le mandat de compte signé."),
      description: L(lang, "ABC Capital has not sent the document requested on 14 May 2025.", "ABC Capital n'a pas envoyé le document demandé le 14 mai 2025."),
      action: { type: "request_document", title: L(lang, "Draft follow-up email", "Rédiger l'email de relance"), description: L(lang, "Request the signed Account Mandate", "Demander le mandat de compte signé"), parameters: { document: "Signed Account Mandate" } },
    },
    sources: Array.from({ length: 10 }, (_, i) => ({
      emailId: `msg-horizon-${i + 1}`,
      subject: i === 9 ? "Re: Project Horizon — Q2 vendor risk assessment" : `Re: Project Horizon — onboarding (${i + 1})`,
      from: i % 2 ? "James Carter" : "Sarah Johnson",
      date: new Date(Date.UTC(2025, 4, 14 + i, 9, 0)).toISOString(),
    })),
    confidence: 0.92,
    auditId: id("aud"),
    generatedAt: now(),
    model: MODEL,
  };
}

export function mockChat(lang: Language, sessionId: string): ChatResponse {
  return {
    sessionId,
    headline: L(lang, "Client approval detected", "Approbation du client détectée"),
    answer: L(
      lang,
      "I found 3 emails that may contain the client's approval of the mandate. The most relevant result is highlighted.",
      "J'ai trouvé 3 emails susceptibles de contenir l'approbation du mandat par le client. Le résultat le plus pertinent est mis en évidence.",
    ),
    sources: [
      { emailId: "msg-2025-05-24-001", conversationId: "conv-abc-capital-horizon", subject: "Re: Mandate Approval – ABC Capital", from: "James Carter", date: "2025-05-24T07:47:00.000Z", relevance: 0.95, excerpt: "We confirm our approval of the mandate as outlined in the Investment Management Agreement dated 20 May 2025." },
      { emailId: "msg-2025-05-21-002", conversationId: "conv-abc-capital-horizon", subject: "FW: Mandate Documents – ABC Capital", from: "Sarah Johnson", date: "2025-05-21T13:12:00.000Z", relevance: 0.78, excerpt: "Forwarding the mandate documents for your records." },
      { emailId: "msg-2025-05-22-001", subject: "Mandate Approval Confirmation", from: "Operations Desk", date: "2025-05-22T08:05:00.000Z", relevance: 0.62, excerpt: "Confirmation of the mandate approval received." },
    ],
    evidence: {
      emailId: "msg-2025-05-24-001",
      subject: "Re: Mandate Approval – ABC Capital",
      quote: "… We confirm our approval of the mandate as outlined in the Investment Management Agreement dated 20 May 2025.",
      author: "James Carter",
      date: "2025-05-24T07:47:00.000Z",
    },
    confidence: 0.9,
    auditId: id("aud"),
    model: MODEL,
  };
}

export function mockProposal(lang: Language): ActionProposal {
  const actions: ProposedAction[] = [
    { id: "act-1", type: "draft_reply", title: L(lang, "Send draft reply", "Ouvrir le brouillon de réponse"), explanation: L(lang, "Opens an AI-prepared reply acknowledging the report. Nothing is sent without you.", "Ouvre une réponse préparée par l'IA accusant réception du rapport. Rien n'est envoyé sans vous."), source: { kind: "email", label: "James Smith", detail: L(lang, "Today at 9:24 AM", "Aujourd'hui à 09:24"), emailId: "msg-2025-05-25-001" }, riskLevel: "low", requiresApproval: true, requiresComplianceApproval: false, executionTarget: "client", parameters: { intent: "acknowledge" }, selectedByDefault: true },
    { id: "act-2", type: "archive", title: L(lang, "Archive email thread", "Archiver le fil"), explanation: L(lang, "Moves the completed part of the thread to Archive.", "Déplace la partie terminée du fil vers Archive."), source: { kind: "email", label: "James Smith", detail: L(lang, "Today at 9:24 AM", "Aujourd'hui à 09:24") }, riskLevel: "low", requiresApproval: true, requiresComplianceApproval: false, executionTarget: "server", parameters: {}, selectedByDefault: true },
    { id: "act-3", type: "create_reminder", title: L(lang, "Create calendar reminder", "Créer un rappel calendrier"), explanation: L(lang, "Reminder on 28 May to chase the signed Account Mandate.", "Rappel le 28 mai pour relancer le mandat de compte signé."), source: { kind: "attachment", label: "ABC Capital Mandate.pdf" }, riskLevel: "medium", requiresApproval: true, requiresComplianceApproval: false, executionTarget: "server", parameters: { start: "2025-05-28T08:00:00.000Z" }, selectedByDefault: true },
    { id: "act-4", type: "categorize", title: L(lang, "Tag as client mandate", "Catégoriser « mandat client »"), explanation: L(lang, "Applies the 'Client Mandate' category for tracking.", "Applique la catégorie « Client Mandate » pour le suivi."), source: { kind: "rule", label: L(lang, "Internal Rule", "Règle interne"), detail: "Client Mandate Workflow" }, riskLevel: "low", requiresApproval: true, requiresComplianceApproval: false, executionTarget: "client", parameters: { category: "Client Mandate" }, selectedByDefault: true },
    { id: "act-5", type: "notify", title: L(lang, "Notify relationship manager", "Notifier le relationship manager"), explanation: L(lang, "Sends an internal notification about the outstanding document.", "Envoie une notification interne sur le document manquant."), source: { kind: "rule", label: L(lang, "Internal Rule", "Règle interne"), detail: "Client Mandate Workflow" }, riskLevel: "low", requiresApproval: true, requiresComplianceApproval: false, executionTarget: "server", parameters: {}, selectedByDefault: true },
  ];
  return { proposalId: id("prop"), actions, humanValidationRequired: true, auditId: id("aud"), createdAt: now(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
}

export function mockComplianceIssues(lang: Language): ComplianceIssue[] {
  return [
    { id: "iss-1", code: "external_recipient", title: L(lang, "External recipient detected", "Destinataire externe détecté"), description: L(lang, "michael.brown@clientco.com is outside your organization.", "michael.brown@clientco.com est en dehors de votre organisation."), severity: "high", subject: "michael.brown@clientco.com" },
    { id: "iss-2", code: "confidential_attachment", title: L(lang, "Confidential attachment", "Pièce jointe confidentielle"), description: L(lang, "Client A – Q2 Performance Report.pdf is classified as confidential.", "Client A – Q2 Performance Report.pdf est classé confidentiel."), severity: "high", subject: "Client A – Q2 Performance Report.pdf" },
    { id: "iss-3", code: "missing_classification_label", title: L(lang, "Missing classification label", "Étiquette de classification manquante"), description: L(lang, "This email is not labeled. Policy requires a classification.", "Cet email n'est pas étiqueté. La politique exige une classification."), severity: "medium" },
    { id: "iss-4", code: "sensitive_client_information", title: L(lang, "Sensitive client information found", "Informations client sensibles détectées"), description: L(lang, "Content may contain sensitive client or portfolio information.", "Le contenu peut contenir des informations sensibles sur un client ou un portefeuille."), severity: "high" },
  ];
}

export function mockCompliance(lang: Language, hasExternal: boolean): ComplianceCheckResponse {
  const issues = hasExternal ? mockComplianceIssues(lang) : [];
  return {
    issues,
    recommendedActions: hasExternal
      ? [
          { type: "apply_label", title: L(lang, "Apply confidential label", "Appliquer l'étiquette Confidentiel"), description: L(lang, "Label this email as Confidential.", "Étiqueter cet email comme Confidentiel."), parameters: { label: "Confidential" } },
          { type: "remove_attachment", title: L(lang, "Remove attachment", "Supprimer la pièce jointe"), description: "Client A – Q2 Performance Report.pdf", parameters: { name: "Client A – Q2 Performance Report.pdf" } },
          { type: "request_approval", title: L(lang, "Request approval", "Demander une approbation"), description: L(lang, "Request approval from a manager or compliance officer.", "Demander l'approbation d'un manager ou d'un compliance officer."), parameters: {} },
          { type: "escalate_compliance", title: L(lang, "Send for compliance review", "Envoyer pour revue Compliance"), description: L(lang, "Route this draft to the Compliance Team.", "Transmettre ce brouillon à l'équipe Compliance."), parameters: {} },
        ]
      : [],
    verdict: hasExternal ? "warn" : "allow",
    confidence: 0.92,
    auditId: id("aud"),
    checkedAt: now(),
  };
}

export function mockAutomation(lang: Language, status: Automation["status"] = "proposed"): Automation {
  return {
    id: "auto-client-a-reporting",
    name: L(lang, "Client A Reporting", "Reporting Client A"),
    description: L(lang, "a repeated workflow you do every morning for Client A reporting emails", "un flux répété chaque matin pour les emails de reporting Client A"),
    trigger: {
      description: L(lang, "Emails from Client A Reporting with attachments", "Emails de Client A Reporting avec pièces jointes"),
      conditions: { fromAddress: "reporting@client-a.example", hasAttachments: true, attachmentTypes: ["pdf", "xlsx"] },
    },
    steps: [
      { order: 1, type: "detect_attachment", title: L(lang, "Detect attachment", "Détecter la pièce jointe"), description: L(lang, "Detect email with attachment from Client A Reporting", "Détecter un email avec pièce jointe de Client A Reporting"), parameters: {} },
      { order: 2, type: "save_attachment", title: L(lang, "Save to Client A folder", "Enregistrer dans le dossier Client A"), description: L(lang, "Save attachment to \\\\Reports\\Client A\\Daily Reports", "Enregistrer la pièce jointe dans \\\\Reports\\Client A\\Daily Reports"), parameters: { path: "\\\\Reports\\Client A\\Daily Reports" } },
      { order: 3, type: "categorize", title: L(lang, "Apply category", "Appliquer la catégorie"), description: L(lang, "Categorize email as 'Client A – Reporting'", "Catégoriser l'email « Client A – Reporting »"), parameters: { category: "Client A – Reporting" } },
      { order: 4, type: "create_reminder", title: L(lang, "Create reminder", "Créer un rappel"), description: L(lang, "Create follow-up task to review the report", "Créer une tâche de suivi pour examiner le rapport"), parameters: {} },
    ],
    status,
    stats: { occurrences: 25, perWeek: 5, estimatedMinutesPerOccurrence: 3.6, estimatedMinutesSavedPerWeek: 18 },
    confidence: 0.94,
    riskLevel: "low",
    createdAt: "2025-05-19T06:30:00.000Z",
    updatedAt: now(),
  };
}

function mockSimulation(lang: Language, a: Automation, sampleSize: number): Automation {
  return {
    ...a,
    status: "simulated",
    updatedAt: now(),
    lastSimulation: {
      runAt: now(),
      sampleSize,
      checks: [
        { name: L(lang, "Attachment detection accuracy", "Précision de la détection des pièces jointes"), passed: true, detail: `${sampleSize}/${sampleSize}` },
        { name: L(lang, "Correct folder mapping", "Correspondance de dossier correcte"), passed: true },
        { name: L(lang, "Category assignment", "Attribution de la catégorie"), passed: true },
        { name: L(lang, "Reminder creation", "Création du rappel"), passed: sampleSize <= 10, detail: sampleSize > 10 ? L(lang, "1 reminder would collide with an existing task", "1 rappel entrerait en conflit avec une tâche existante") : undefined },
      ],
      results: Array.from({ length: sampleSize }, (_, i) => ({
        emailId: `msg-client-a-${i + 1}`,
        subject: `Daily report – ${new Date(Date.UTC(2025, 4, 5 + i, 6, 30)).toLocaleDateString(lang === "fr" ? "fr-CH" : "en-GB")}`,
        wouldApply: i !== 7,
        stepsPreview: i === 7 ? [L(lang, "No attachment → skipped", "Pas de pièce jointe → ignoré")] : a.steps.map((s) => s.title),
      })),
    },
  };
}

/* ------------------------------------------------------------------ client */

export function createMockClient(getLanguage: () => import("@oao/shared").Language, latency = 500): OaoApi {
  let automations: Automation[] = [mockAutomation(getLanguage()), { ...mockAutomation(getLanguage(), "active"), id: "auto-invoices", name: getLanguage() === "fr" ? "Factures fournisseurs" : "Vendor invoices", stats: { occurrences: 40, perWeek: 8, estimatedMinutesPerOccurrence: 2, estimatedMinutesSavedPerWeek: 16 } }];
  const lastProposals = new Map<string, ActionProposal>();

  const wait = (factor = 1) => sleep(latency * factor);

  return {
    mode: "mock",
    health: async () => validate(HealthSchema, { status: "ok", checks: { db: { status: "ok" }, llm: { status: "ok", detail: "mock" } }, version: "mock", timestamp: now() }, "health"),
    analyzeEmail: async (req) => {
      await wait(1.6);
      const phishing = /urgent|password|wire transfer/i.test(req.email.subject + req.email.body) && !/Project Horizon/i.test(req.email.subject);
      return validate(EmailAnalysisSchema, mockAnalysis(req.language ?? getLanguage(), req.email.id, phishing), "analyzeEmail");
    },
    analyzeThread: async (req) => {
      await wait(2);
      return validate(ThreadSynthesisSchema, mockThread(req.language ?? getLanguage(), req.thread.conversationId), "analyzeThread");
    },
    draftReply: async (req) => {
      await wait(1.5);
      const lang = req.language ?? getLanguage();
      const name = req.email.from?.name?.split(" ")[0] ?? "";
      const body = L(
        lang,
        `Dear ${name},\n\nThank you for sharing the Q2 vendor risk assessment. I will review the high-risk findings and come back to you with my input by the end of the week.\n\nCould you also send the signed Account Mandate requested on 14 May so we can keep the 30 May onboarding date?\n\nKind regards,\nJane Smith`,
        `Bonjour ${name},\n\nMerci pour l'évaluation des risques fournisseurs du T2. Je vais examiner les constats à risque élevé et reviendrai vers vous d'ici la fin de la semaine.\n\nPourriez-vous également nous transmettre le mandat de compte signé demandé le 14 mai afin de tenir la date d'onboarding du 30 mai ?\n\nCordialement,\nJane Smith`,
      );
      return validate(DraftReplySchema, { subject: `RE: ${req.email.subject}`, body: req.instructions ? `${req.instructions}\n\n${body}` : body, language: lang, confidence: 0.86, auditId: id("aud"), model: MODEL }, "draftReply");
    },
    chat: async (req) => {
      await wait(1.8);
      return validate(ChatResponseSchema, mockChat(req.language ?? getLanguage(), req.sessionId ?? id("sess")), "chat");
    },
    indexEmails: async (req) => {
      await wait(1.2);
      return validate(IndexEmailsResponseSchema, { indexed: req.emails.length, skipped: 0, mode: "hybrid" }, "indexEmails");
    },
    proposeActions: async (req) => {
      await wait(1.4);
      const proposal = validate(ActionProposalSchema, mockProposal(req.language ?? getLanguage()), "proposeActions");
      lastProposals.set(proposal.proposalId, proposal);
      return proposal;
    },
    approveActions: async (req) => {
      await wait(1.2);
      const proposal = lastProposals.get(req.proposalId) ?? mockProposal(getLanguage());
      const results: ActionResult[] = req.actionIds.map((actionId) => {
        const a = proposal.actions.find((x) => x.id === actionId);
        const type = a?.type ?? "notify";
        const base = { actionId, type, auditId: id("aud") };
        if (a?.requiresComplianceApproval || type === "escalate_compliance") return { ...base, status: "pending_compliance", message: "Escalated to the Compliance Team" };
        switch (type) {
          case "draft_reply":
            return { ...base, status: "pending_client", clientInstruction: { operation: "displayReplyForm", parameters: { htmlBody: "<p>Dear Sarah,</p><p>Thank you for the Q2 vendor risk assessment. I will review the high-risk findings and revert by the end of the week.</p><p>Kind regards,<br/>Jane</p>" } } };
          case "categorize":
          case "classify_email":
            return { ...base, status: "pending_client", clientInstruction: { operation: "addCategory", parameters: { category: String(a?.parameters.category ?? "Client Mandate") } } };
          case "create_reminder":
          case "create_task":
            // Graph disabled in mock → fallback to the client appointment form.
            return { ...base, status: "pending_client", message: "Graph disabled — client fallback", clientInstruction: { operation: "displayNewAppointmentForm", parameters: { subject: "Follow-up: signed Account Mandate", start: a?.parameters.start ?? new Date(Date.now() + 86_400_000).toISOString() } } };
          case "archive":
          case "move_to_folder":
            return { ...base, status: "pending_client", clientInstruction: { operation: "openMoveDialog", parameters: { folder: "Archive" } } };
          case "flag":
            return { ...base, status: "pending_client", clientInstruction: { operation: "flag", parameters: {} } };
          case "apply_label":
            return { ...base, status: "pending_client", clientInstruction: { operation: "applyLabel", parameters: { label: "Confidential" } } };
          case "remove_attachment":
            return { ...base, status: "pending_client", clientInstruction: { operation: "removeAttachment", parameters: a?.parameters ?? {} } };
          default:
            return { ...base, status: "executed", message: "Logged in the audit trail" };
        }
      });
      return validate(ApproveActionsResponseSchema, { proposalId: req.proposalId, results }, "approveActions");
    },
    reportActionResult: async () => {
      await wait(0.3);
    },
    complianceCheck: async (req) => {
      await wait(1.5);
      const external = [...req.draft.to, ...req.draft.cc, ...req.draft.bcc].some((r) => !/@(longbow\.ch|longbowfinance\.com)$/i.test(r.address));
      return validate(ComplianceCheckResponseSchema, mockCompliance(req.language ?? getLanguage(), external), "complianceCheck");
    },
    createEscalation: async (req) => {
      await wait(1);
      return validate(EscalationSchema, { id: id("esc"), status: "pending", requestedBy: "jane.smith@longbow.ch", requestedAt: now(), reason: req.reason, issues: req.issues ?? [] }, "escalation");
    },
    observe: async () => {
      await wait(0.1);
    },
    listAutomations: async () => {
      await wait(0.8);
      return automations.map((a) => validate(AutomationSchema, a, "automation"));
    },
    detectAutomations: async () => {
      await wait(1.8);
      if (!automations.some((a) => a.status === "proposed" || a.status === "simulated")) automations = [mockAutomation(getLanguage()), ...automations];
      return automations.filter((a) => a.status === "proposed" || a.status === "simulated");
    },
    simulateAutomation: async (aid, req) => {
      await wait(2.2);
      const a = automations.find((x) => x.id === aid) ?? mockAutomation(getLanguage());
      const simulated = mockSimulation(getLanguage(), a, req.sampleSize ?? 10);
      automations = automations.map((x) => (x.id === aid ? simulated : x));
      return validate(AutomationSchema, simulated, "simulate");
    },
    approveAutomation: async (aid) => {
      await wait(1);
      automations = automations.map((x) => (x.id === aid ? { ...x, status: "active", updatedAt: now() } : x));
      return validate(AutomationSchema, automations.find((x) => x.id === aid) ?? mockAutomation(getLanguage(), "active"), "approve");
    },
    rejectAutomation: async (aid) => {
      await wait(0.8);
      automations = automations.map((x) => (x.id === aid ? { ...x, status: "rejected", updatedAt: now() } : x));
      return validate(AutomationSchema, automations.find((x) => x.id === aid) ?? mockAutomation(getLanguage(), "rejected"), "reject");
    },
    feedback: async () => {
      await wait(0.3);
    },
  };
}

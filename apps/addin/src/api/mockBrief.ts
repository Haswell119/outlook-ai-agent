/**
 * Daily brief, sync status and feature-flag fixtures for the mock API.
 *
 * Kept in their own module so `mock.ts` stays readable and so the e2e specs and
 * the screenshot script can import a deterministic brief (fixed date, fixed
 * numbers) without pulling in the whole client.
 *
 * All names are placeholders (`northbridge.example`, "ABC Capital") — see the
 * public-repository rule in the README.
 */
import type { DailyBrief, FeatureFlags, Language, MailboxSyncStatus } from "@oao/shared";

function L<T>(lang: Language, en: T, fr: T): T {
  return lang === "fr" ? fr : en;
}

/** Deterministic "today" for the fixtures (matches the sample conversation). */
export const MOCK_BRIEF_DATE = "2025-05-26";

export function mockDailyBrief(lang: Language, date = MOCK_BRIEF_DATE, source: DailyBrief["source"] = "precomputed"): DailyBrief {
  return {
    date,
    language: lang,
    headline: L(
      lang,
      "3 items need you today: the ABC Capital mandate is still blocked, two replies are overdue.",
      "3 points requièrent votre attention aujourd'hui : le mandat ABC Capital est toujours bloqué, deux réponses sont en retard.",
    ),
    highlights: [
      L(
        lang,
        "Project Horizon onboarding is blocked on the signed Account Mandate (requested 12 days ago).",
        "L'onboarding Project Horizon est bloqué par le mandat de compte signé (demandé il y a 12 jours).",
      ),
      L(lang, "Target onboarding date is 30 May — 4 days left.", "La date cible d'onboarding est le 30 mai — il reste 4 jours."),
      L(lang, "One inbound email was flagged as suspicious overnight.", "Un email entrant a été signalé comme suspect cette nuit."),
      L(lang, "Legal sign-off on the Q2 vendor risk assessment is still pending.", "La validation Legal de l'évaluation des risques fournisseurs T2 est toujours en attente."),
    ],
    priorityEmails: [
      {
        emailId: "msg-2025-05-25-001",
        conversationId: "conv-abc-capital-horizon",
        subject: "Re: Project Horizon — Q2 vendor risk assessment",
        from: "Sarah Johnson",
        receivedAt: "2025-05-25T07:24:00.000Z",
        reason: L(lang, "High-risk findings await your approval before onboarding.", "Des constats à risque élevé attendent votre approbation avant l'onboarding."),
        priority: "high",
        riskLevel: "high",
      },
      {
        emailId: "msg-2025-05-26-004",
        conversationId: "conv-abc-capital-horizon",
        subject: "Account Mandate — follow-up needed",
        from: "James Carter",
        receivedAt: "2025-05-26T06:02:00.000Z",
        reason: L(lang, "Second reminder sent; no signed document received yet.", "Deuxième relance envoyée ; aucun document signé reçu à ce jour."),
        priority: "high",
        riskLevel: "medium",
      },
      {
        emailId: "msg-2025-05-26-011",
        subject: "Q2 performance pack — distribution list",
        from: "Operations Desk",
        receivedAt: "2025-05-26T05:41:00.000Z",
        reason: L(lang, "Awaiting your confirmation of the recipient list.", "En attente de votre confirmation de la liste de destinataires."),
        priority: "medium",
        riskLevel: "low",
      },
    ],
    openTasks: [
      {
        title: L(lang, "Obtain the signed Account Mandate", "Obtenir le mandat de compte signé"),
        owner: "Jane Smith",
        priority: "high",
        dueDate: "2025-05-28",
        done: false,
        critical: true,
      },
      { title: L(lang, "Complete KYC validation", "Finaliser la validation KYC"), owner: L(lang, "Compliance Team", "Équipe Compliance"), priority: "medium", done: false, critical: false },
      { title: L(lang, "Confirm the Q2 distribution list", "Confirmer la liste de diffusion T2"), priority: "low", done: false, critical: false },
    ],
    deadlines: [
      { title: L(lang, "Target onboarding date", "Date cible d'onboarding"), date: "2025-05-30", description: L(lang, "4 days left", "il reste 4 jours"), atRisk: true },
      { title: L(lang, "Quarterly compliance attestation", "Attestation de conformité trimestrielle"), date: "2025-06-15", atRisk: false },
    ],
    alerts: [
      {
        code: "suspicious_inbound",
        title: L(lang, "1 suspicious inbound email", "1 email entrant suspect"),
        description: L(lang, "Sender domain does not match the display name.", "Le domaine de l'expéditeur ne correspond pas au nom affiché."),
        severity: "medium",
      },
    ],
    stats: { newEmails: 42, analysed: 38, awaitingReply: 6, phishingSuspected: 1 },
    confidence: 0.89,
    source,
    generatedAt: `${date}T05:30:00.000Z`,
    auditId: `aud-brief-${date}`,
  };
}

export function mockSyncStatus(overrides: Partial<MailboxSyncStatus> = {}): MailboxSyncStatus {
  return {
    enabled: true,
    state: "idle",
    lastSyncAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    nextSyncAt: new Date(Date.now() + 48 * 60_000).toISOString(),
    indexedEmails: 1_284,
    precomputedAnalyses: 317,
    pending: 4,
    ...overrides,
  };
}

export function mockFeatures(overrides: Partial<FeatureFlags> = {}): FeatureFlags {
  return {
    graphEnabled: true,
    embeddingsEnabled: true,
    llmProvider: "openai-compatible",
    llmModel: "qwen3-30b-a3b",
    llmFastModel: "qwen3-4b",
    embeddingModel: "bge-m3",
    authMode: "dev",
    precomputeEnabled: true,
    dailyBriefEnabled: true,
    organizationName: "Northbridge Capital",
    version: "mock",
    ...overrides,
  };
}

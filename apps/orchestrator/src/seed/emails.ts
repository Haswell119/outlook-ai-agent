import type { EmailContext } from "@oao/shared";

/**
 * 40 sample emails (FR/EN) telling the "Project Horizon — ABC Capital mandate onboarding"
 * story, plus a few routine reporting emails and one phishing attempt, so that
 * search / chat / thread synthesis / automation detection work out of the box.
 */
const P = {
  jane: { name: "Jane Smith", address: "jane.smith@northbridge.example" },
  marc: { name: "Marc Dubois", address: "marc.dubois@northbridge.example" },
  sophie: { name: "Sophie Martin", address: "sophie.martin@northbridge.example" },
  compliance: { name: "Compliance Team", address: "compliance@northbridge.example" },
  legal: { name: "Legal Team", address: "legal@northbridge.example" },
  james: { name: "James Carter", address: "james.carter@abccapital.com" },
  laura: { name: "Laura Chen", address: "laura.chen@abccapital.com" },
  reports: { name: "ABC Capital Reporting", address: "reports@abccapital.com" },
  custodian: { name: "Custody Services", address: "custody@swissbank-custody.ch" },
  phisher: { name: "Northbridge IT Support", address: "it-support@northbridqe-finance.com" },
};

const CONV = "AAQkADQ2-horizon-abc-capital";

interface Spec {
  daysAgo: number;
  from: keyof typeof P;
  to: Array<keyof typeof P>;
  cc?: Array<keyof typeof P>;
  subject: string;
  body: string;
  conversationId?: string;
  attachments?: string[];
  categories?: string[];
}

const specs: Spec[] = [
  { daysAgo: 34, from: "james", to: ["jane"], subject: "Project Horizon – ABC Capital mandate: kick-off", conversationId: CONV, body: "Dear Jane,\n\nFollowing our meeting last week, ABC Capital would like to proceed with the discretionary mandate under Project Horizon. Please send us the onboarding checklist and the Investment Management Agreement draft.\n\nWe are targeting an onboarding date of 30 May 2025.\n\nBest regards,\nJames Carter\nCOO, ABC Capital" },
  { daysAgo: 33, from: "jane", to: ["james"], cc: ["marc"], subject: "RE: Project Horizon – ABC Capital mandate: kick-off", conversationId: CONV, attachments: ["Onboarding Checklist – ABC Capital.pdf", "IMA Draft v1 – Project Horizon.docx"], body: "Dear James,\n\nThank you for confirming. Please find attached the onboarding checklist and the draft Investment Management Agreement (IMA) for Project Horizon.\n\nThe key documents we need from ABC Capital are:\n1. Signed Account Mandate\n2. KYC documents for the beneficial owners (passport copies, proof of address)\n3. Board resolution approving the mandate\n\nKind regards,\nJane Smith\nRelationship Manager, Northbridge Capital" },
  { daysAgo: 31, from: "laura", to: ["jane"], cc: ["james"], subject: "RE: Project Horizon – KYC documents", conversationId: CONV, attachments: ["ABC Capital – Passport copies.pdf", "ABC Capital – Proof of address.pdf"], body: "Hi Jane,\n\nPlease find attached the KYC documents for the two beneficial owners of ABC Capital (passport copies and proof of address). The board resolution will follow next week.\n\nLet us know if anything is missing.\n\nBest,\nLaura Chen\nOperations, ABC Capital" },
  { daysAgo: 30, from: "jane", to: ["compliance"], cc: ["marc"], subject: "Project Horizon – KYC validation request (ABC Capital)", conversationId: CONV, body: "Bonjour,\n\nMerci de lancer la validation KYC pour ABC Capital (Project Horizon). Les copies de passeport et justificatifs de domicile des deux ayants droit économiques sont dans le dossier client.\n\nLa date cible d'onboarding est le 30 mai 2025.\n\nMerci d'avance,\nJane" },
  { daysAgo: 28, from: "compliance", to: ["jane"], subject: "RE: Project Horizon – KYC validation request (ABC Capital)", conversationId: CONV, body: "Bonjour Jane,\n\nLa validation KYC d'ABC Capital est en cours. Les passeports sont conformes. Il nous manque encore la résolution du conseil d'administration approuvant le mandat.\n\nDélai estimé : 5 jours ouvrés après réception.\n\nCordialement,\nCompliance Team" },
  { daysAgo: 27, from: "james", to: ["jane"], subject: "Project Horizon – Board resolution", conversationId: CONV, attachments: ["ABC Capital – Board Resolution 2025-05-12.pdf"], body: "Dear Jane,\n\nAttached is the signed board resolution approving the discretionary mandate with Northbridge Capital under Project Horizon.\n\nWe will review the IMA draft this week and revert with comments.\n\nBest regards,\nJames" },
  { daysAgo: 26, from: "jane", to: ["james"], cc: ["laura"], subject: "Project Horizon – Signed Account Mandate needed", conversationId: CONV, body: "Dear James,\n\nThank you for the board resolution. To complete the onboarding we still need the signed Account Mandate (form attached to my earlier email). Could you please return it signed by both authorised signatories?\n\nThis document is required before we can open the portfolio and trade.\n\nKind regards,\nJane" },
  { daysAgo: 25, from: "james", to: ["jane"], subject: "RE: Project Horizon – Signed Account Mandate needed", conversationId: CONV, body: "Hi Jane,\n\nUnderstood – our second signatory is travelling until 22 May. We will send the signed Account Mandate as soon as he is back.\n\nJames" },
  { daysAgo: 24, from: "marc", to: ["jane"], subject: "Horizon – point d'avancement onboarding ABC Capital", conversationId: CONV, body: "Salut Jane,\n\nPetit point sur Project Horizon : le KYC est presque terminé, la résolution du conseil est reçue. Il reste le mandat de gestion signé (Account Mandate) et la validation finale du service juridique sur l'IMA.\n\nOn vise toujours le 30 mai ? Cela devient serré si le mandat signé n'arrive pas avant le 26.\n\nMarc" },
  { daysAgo: 23, from: "legal", to: ["jane"], cc: ["marc"], subject: "IMA Project Horizon – legal review comments", conversationId: CONV, attachments: ["IMA Draft v2 – Project Horizon (Legal comments).docx"], body: "Dear Jane,\n\nPlease find our comments on the IMA draft for Project Horizon. Two clauses need to be adjusted (fees schedule and termination notice). Once ABC Capital confirms, we can issue the final version for signature.\n\nLegal final sign-off will follow once the signed Account Mandate is on file.\n\nRegards,\nLegal Team" },
  { daysAgo: 22, from: "jane", to: ["james"], cc: ["laura", "marc"], subject: "Re: Mandate Approval – ABC Capital", conversationId: CONV, attachments: ["IMA Final – Project Horizon.pdf"], body: "Dear James,\n\nPlease find attached the final Investment Management Agreement dated 20 May 2025 incorporating the agreed changes on the fee schedule and the termination notice.\n\nCould you confirm ABC Capital's approval of the mandate as outlined, and return the signed Account Mandate?\n\nKind regards,\nJane" },
  { daysAgo: 21, from: "james", to: ["jane"], cc: ["laura", "marc"], subject: "Re: Mandate Approval – ABC Capital", conversationId: CONV, body: "Dear Jane,\n\nWe confirm our approval of the mandate as outlined in the Investment Management Agreement dated 20 May 2025. The fee schedule and termination notice are acceptable to ABC Capital.\n\nThe signed Account Mandate will be couriered once our second signatory returns on 22 May.\n\nBest regards,\nJames Carter" },
  { daysAgo: 20, from: "laura", to: ["jane"], subject: "FW: Mandate Documents – ABC Capital", conversationId: CONV, attachments: ["ABC Capital – Mandate documents pack.zip"], body: "Hi Jane,\n\nForwarding the full mandate documents pack (IMA signed by James, KYC forms, board resolution). The Account Mandate is still pending the second signature.\n\nBest,\nLaura" },
  { daysAgo: 19, from: "jane", to: ["marc"], subject: "Horizon – mandat signé toujours manquant", conversationId: CONV, body: "Marc,\n\nLe mandat de gestion signé (Signed Account Mandate) est toujours manquant côté ABC Capital. Je relance James demain. Si nous ne l'avons pas d'ici le 26 mai, la date d'onboarding du 30 mai est à risque.\n\nJane" },
  { daysAgo: 18, from: "jane", to: ["james"], subject: "Project Horizon – gentle reminder: signed Account Mandate", conversationId: CONV, body: "Dear James,\n\nA gentle reminder that we are still waiting for the signed Account Mandate. Everything else is in place (KYC validated, board resolution, IMA approved). The target onboarding date of 30 May is at risk of delay if the document is not received by 26 May.\n\nMany thanks,\nJane" },
  { daysAgo: 17, from: "compliance", to: ["jane"], cc: ["marc"], subject: "Project Horizon – KYC validation complete", conversationId: CONV, body: "Bonjour Jane,\n\nLa validation KYC d'ABC Capital est terminée et approuvée. Le dossier est conforme. Nous restons en attente du mandat signé pour clôturer l'onboarding.\n\nCordialement,\nCompliance Team" },
  { daysAgo: 16, from: "james", to: ["jane"], subject: "Mandate Approval Confirmation", conversationId: CONV, body: "Dear Jane,\n\nThis is to confirm that ABC Capital's investment committee has approved the discretionary mandate with Northbridge Capital (Project Horizon). The signed Account Mandate is being couriered today and should reach you by Monday.\n\nBest regards,\nJames" },
  { daysAgo: 15, from: "sophie", to: ["jane"], subject: "Horizon – préparation du portefeuille ABC Capital", conversationId: CONV, body: "Bonjour Jane,\n\nJe prépare l'ouverture du portefeuille ABC Capital (Project Horizon) chez le dépositaire. Peux-tu me confirmer le profil de risque (équilibré ?) et la devise de référence (CHF ou USD) ?\n\nMerci,\nSophie" },
  { daysAgo: 14, from: "jane", to: ["sophie"], subject: "RE: Horizon – préparation du portefeuille ABC Capital", conversationId: CONV, body: "Bonjour Sophie,\n\nProfil équilibré, devise de référence USD. Le mandat signé devrait arriver lundi ; on pourra ouvrir le compte dès réception.\n\nJane" },
  { daysAgo: 13, from: "custodian", to: ["sophie"], cc: ["jane"], subject: "Account opening – ABC Capital (Project Horizon) – reference HZ-2025-0417", body: "Dear Sophie,\n\nWe confirm the account opening request for ABC Capital under reference HZ-2025-0417. The account will be activated upon receipt of the signed mandate documents.\n\nKind regards,\nCustody Services" },
  { daysAgo: 12, from: "james", to: ["jane"], cc: ["laura"], subject: "Project Horizon – Signed Account Mandate", conversationId: CONV, attachments: ["ABC Capital – Signed Account Mandate.pdf"], body: "Dear Jane,\n\nPlease find attached the scanned signed Account Mandate; the original is with the courier. This should complete the documentation for Project Horizon.\n\nBest regards,\nJames" },
  { daysAgo: 11, from: "jane", to: ["legal"], cc: ["marc"], subject: "Project Horizon – legal final sign-off request", conversationId: CONV, body: "Dear Legal Team,\n\nThe signed Account Mandate from ABC Capital is now on file. Could you please proceed with the final sign-off of the IMA so that we can activate the portfolio before 30 May?\n\nThank you,\nJane" },
  { daysAgo: 10, from: "legal", to: ["jane"], subject: "RE: Project Horizon – legal final sign-off request", conversationId: CONV, body: "Dear Jane,\n\nLegal sign-off granted for the ABC Capital IMA (Project Horizon). The executed agreement is archived in the contracts repository.\n\nRegards,\nLegal Team" },
  { daysAgo: 9, from: "jane", to: ["james"], cc: ["laura", "marc", "sophie"], subject: "Project Horizon – onboarding complete, welcome to Northbridge", conversationId: CONV, body: "Dear James, dear Laura,\n\nWe are pleased to confirm that the onboarding of ABC Capital under Project Horizon is complete. The portfolio (reference HZ-2025-0417) is active as of today and the first investments will be executed according to the agreed balanced profile.\n\nThank you for your cooperation.\n\nKind regards,\nJane Smith" },
  { daysAgo: 8, from: "james", to: ["jane"], subject: "RE: Project Horizon – onboarding complete, welcome to Northbridge", conversationId: CONV, body: "Thank you Jane – great news. Looking forward to the first monthly report.\n\nJames" },
  // Routine reporting emails (Automation Coach story): daily reports from ABC Capital Reporting with attachments.
  { daysAgo: 7, from: "reports", to: ["jane"], subject: "Daily report – ABC Capital – 2025-06-02", attachments: ["ABC Capital – Daily Report 2025-06-02.xlsx"], body: "Please find attached the daily positions report for ABC Capital. This report is generated automatically. Do not reply to this email." },
  { daysAgo: 6, from: "reports", to: ["jane"], subject: "Daily report – ABC Capital – 2025-06-03", attachments: ["ABC Capital – Daily Report 2025-06-03.xlsx"], body: "Please find attached the daily positions report for ABC Capital. This report is generated automatically. Do not reply to this email." },
  { daysAgo: 5, from: "reports", to: ["jane"], subject: "Daily report – ABC Capital – 2025-06-04", attachments: ["ABC Capital – Daily Report 2025-06-04.xlsx"], body: "Please find attached the daily positions report for ABC Capital. This report is generated automatically. Do not reply to this email." },
  { daysAgo: 4, from: "reports", to: ["jane"], subject: "Daily report – ABC Capital – 2025-06-05", attachments: ["ABC Capital – Daily Report 2025-06-05.xlsx"], body: "Please find attached the daily positions report for ABC Capital. This report is generated automatically. Do not reply to this email." },
  { daysAgo: 3, from: "reports", to: ["jane"], subject: "Daily report – ABC Capital – 2025-06-06", attachments: ["ABC Capital – Daily Report 2025-06-06.xlsx"], body: "Please find attached the daily positions report for ABC Capital. This report is generated automatically. Do not reply to this email." },
  { daysAgo: 2, from: "reports", to: ["jane"], subject: "Daily report – ABC Capital – 2025-06-09", attachments: ["ABC Capital – Daily Report 2025-06-09.xlsx"], body: "Please find attached the daily positions report for ABC Capital. This report is generated automatically. Do not reply to this email." },
  { daysAgo: 1, from: "reports", to: ["jane"], subject: "Monthly performance report – ABC Capital – May 2025", attachments: ["ABC Capital – Performance Report May 2025.pdf"], body: "Please find attached the monthly performance report for the ABC Capital portfolio (Project Horizon). Performance since inception: +1.2%. This report is confidential." },
  // Other business
  { daysAgo: 6, from: "marc", to: ["jane", "sophie"], subject: "Réunion d'équipe – revue des mandats Q2", body: "Bonjour à tous,\n\nJe vous propose une réunion mardi 10 juin à 14h pour la revue des mandats du Q2 (Project Horizon, Meridian, Atlas). Merci de confirmer votre disponibilité et de préparer un point d'avancement par mandat.\n\nMarc" },
  { daysAgo: 4, from: "laura", to: ["jane"], subject: "ABC Capital – reporting frequency and format", body: "Hi Jane,\n\nQuick question: could the monthly performance report be sent as PDF and Excel, and could we also receive a quarterly risk report? Please let us know by 15 June so we can align our internal reporting calendar.\n\nThanks,\nLaura" },
  { daysAgo: 3, from: "compliance", to: ["jane", "marc", "sophie"], subject: "Rappel : classification des emails sortants", body: "Bonjour à tous,\n\nPetit rappel : tout email contenant des informations client (positions, performance, données KYC) doit porter l'étiquette de classification « Confidential » et ne doit pas être envoyé à des adresses de messagerie grand public.\n\nMerci de votre vigilance,\nCompliance Team" },
  { daysAgo: 2, from: "james", to: ["jane"], subject: "Project Horizon – first monthly review call", body: "Dear Jane,\n\nCould we schedule the first monthly review call for Project Horizon in the week of 16 June? We would like to discuss the initial allocation and the performance report.\n\nBest regards,\nJames" },
  { daysAgo: 2, from: "custodian", to: ["sophie"], subject: "Corporate action notice – portfolio HZ-2025-0417", body: "Dear Sophie,\n\nPlease note the upcoming corporate action (dividend payment) on one of the positions of portfolio HZ-2025-0417. No action required unless you wish to elect the stock dividend option before 20 June.\n\nKind regards,\nCustody Services" },
  { daysAgo: 1, from: "phisher", to: ["jane"], subject: "URGENT: your mailbox password expires today", body: "Dear user,\n\nYour Northbridge mailbox password expires today. To avoid losing access, verify your account immediately by logging in at http://185.203.116.42/owa/login and confirm your password.\n\nThis is your final notice.\n\nIT Support" },
  { daysAgo: 1, from: "marc", to: ["jane"], subject: "Horizon – synthèse pour le comité", body: "Jane,\n\nPeux-tu me préparer une synthèse d'une page de l'onboarding ABC Capital (Project Horizon) pour le comité de direction de jeudi ? Décisions prises, points ouverts, prochaines étapes.\n\nMerci,\nMarc" },
  { daysAgo: 0, from: "jane", to: ["laura"], subject: "RE: ABC Capital – reporting frequency and format", body: "Dear Laura,\n\nYes – from June onwards the monthly performance report will be sent in both PDF and Excel formats, and we will add a quarterly risk report. I will confirm the exact format by 15 June.\n\nKind regards,\nJane" },
];

export function sampleEmails(now = new Date()): EmailContext[] {
  return specs.map((s, i) => {
    const receivedAt = new Date(now.getTime() - s.daysAgo * 86_400_000 - ((i * 37) % 9) * 3_600_000 - ((i * 13) % 50) * 60_000).toISOString();
    const id = `demo-email-${String(i + 1).padStart(3, "0")}`;
    return {
      id,
      conversationId: s.conversationId ?? `conv-${id}`,
      internetMessageId: `<${id}@demo.northbridge.example>`,
      subject: s.subject,
      from: P[s.from],
      to: s.to.map((k) => P[k]),
      cc: (s.cc ?? []).map((k) => P[k]),
      bcc: [],
      receivedAt,
      body: s.body,
      attachments: (s.attachments ?? []).map((name, j) => ({ id: `${id}-att-${j}`, name, contentType: name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream", size: 120_000 + j * 1000 })),
      categories: s.categories ?? [],
      folder: "Inbox",
      webLink: `https://outlook.office.com/mail/inbox/id/${id}`,
    };
  });
}

export const DEMO_PEOPLE = P;
export const DEMO_CONVERSATION_ID = CONV;

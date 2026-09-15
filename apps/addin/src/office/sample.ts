/**
 * Sample data shown in browser-preview mode (no Outlook host).
 * The story follows the mock-ups: ABC Capital / Project Horizon onboarding.
 */
import type { ComposeContext, EmailContext, ThreadContext } from "@oao/shared";

export const SAMPLE_CONVERSATION_ID = "conv-abc-capital-horizon";

export const sampleEmail: EmailContext = {
  id: "msg-2025-05-25-001",
  conversationId: SAMPLE_CONVERSATION_ID,
  internetMessageId: "<horizon-q2-risk@abccapital.example>",
  subject: "Re: Project Horizon — Q2 vendor risk assessment",
  from: { name: "Sarah Johnson", address: "sarah.johnson@abccapital.example" },
  to: [{ name: "Jane Smith", address: "jane.smith@northbridge.example" }],
  cc: [{ name: "James Carter", address: "james.carter@abccapital.example" }],
  bcc: [],
  receivedAt: "2025-05-25T07:24:00.000Z",
  body:
    "Hi Jane,\n\nPlease find attached the Q2 vendor risk assessment report for Project Horizon. " +
    "Several high-risk findings require your input and approval before we can finalise the onboarding.\n\n" +
    "We are still waiting for the signed Account Mandate (requested on 14 May). The target onboarding date remains 30 May 2025.\n\n" +
    "Best regards,\nSarah Johnson\nABC Capital",
  bodyPreview: "Please find attached the Q2 vendor risk assessment report for Project Horizon…",
  attachments: [
    { id: "att-1", name: "Q2 Vendor Risk Assessment.pdf", size: 482_113, contentType: "application/pdf", isInline: false },
  ],
  categories: [],
  importance: "high",
  isRead: true,
  folder: "Inbox",
};

const olderMessages: EmailContext[] = [
  {
    id: "msg-2025-05-14-001",
    conversationId: SAMPLE_CONVERSATION_ID,
    subject: "Project Horizon — onboarding kick-off",
    from: { name: "Jane Smith", address: "jane.smith@northbridge.example" },
    to: [{ name: "Sarah Johnson", address: "sarah.johnson@abccapital.example" }],
    cc: [],
    bcc: [],
    sentAt: "2025-05-14T09:02:00.000Z",
    body: "Dear Sarah, to complete the onboarding of ABC Capital for the Project Horizon mandate we need: the signed Account Mandate, the KYC package and the Investment Management Agreement.",
    attachments: [],
    categories: [],
  },
  {
    id: "msg-2025-05-20-001",
    conversationId: SAMPLE_CONVERSATION_ID,
    subject: "Re: Project Horizon — Investment Management Agreement",
    from: { name: "James Carter", address: "james.carter@abccapital.example" },
    to: [{ name: "Jane Smith", address: "jane.smith@northbridge.example" }],
    cc: [],
    bcc: [],
    receivedAt: "2025-05-20T14:41:00.000Z",
    body: "Jane, attached is the signed Investment Management Agreement dated 20 May 2025. The KYC package follows tomorrow.",
    attachments: [{ id: "att-ima", name: "Investment Management Agreement.pdf", contentType: "application/pdf" }],
    categories: [],
  },
  {
    id: "msg-2025-05-24-001",
    conversationId: SAMPLE_CONVERSATION_ID,
    subject: "Re: Mandate Approval – ABC Capital",
    from: { name: "James Carter", address: "james.carter@abccapital.example" },
    to: [{ name: "Jane Smith", address: "jane.smith@northbridge.example" }],
    cc: [],
    bcc: [],
    receivedAt: "2025-05-24T07:47:00.000Z",
    body: "We confirm our approval of the mandate as outlined in the Investment Management Agreement dated 20 May 2025.",
    attachments: [],
    categories: [],
  },
];

export const sampleThread: ThreadContext = {
  conversationId: SAMPLE_CONVERSATION_ID,
  subject: "Project Horizon — ABC Capital onboarding",
  messages: [...olderMessages, sampleEmail],
};

export const sampleCompose: ComposeContext = {
  draftId: "draft-2025-05-25-001",
  from: { name: "Jane Smith", address: "jane.smith@northbridge.example" },
  to: [{ name: "Michael Brown", address: "michael.brown@clientco.com" }],
  cc: [],
  bcc: [],
  subject: "Client A – Q2 performance report",
  body: "Hi Michael,\n\nPlease find attached the Q2 performance report for Client A (portfolio no. CH-4471-889). Let me know if you have questions.\n\nJane",
  attachments: [
    { id: "att-q2", name: "Client A – Q2 Performance Report.pdf", size: 1_204_331, contentType: "application/pdf", isInline: false },
  ],
};

/**
 * A bulk newsletter, used to review the compact triage layout in browser
 * preview (`taskpane.html?sample=newsletter`). Its id matches the mock API's
 * "this was triaged, no model call" rule.
 */
export const sampleNewsletter: EmailContext = {
  id: "msg-newsletter-weekly-2025-05-26",
  conversationId: "conv-newsletter-weekly",
  subject: "Weekly market commentary — week 22",
  from: { name: "Market Research", address: "noreply@research.example" },
  to: [{ name: "Jane Smith", address: "jane.smith@northbridge.example" }],
  cc: [],
  bcc: [],
  receivedAt: "2025-05-26T05:03:00.000Z",
  body:
    "This week in markets: rates held steady, credit spreads tightened slightly and the energy complex lagged.\n\n" +
    "You are receiving this because you subscribed to the weekly commentary. Unsubscribe at any time.",
  bodyPreview: "This week in markets: rates held steady…",
  attachments: [],
  categories: [],
  importance: "normal",
  isRead: false,
  folder: "Inbox",
};

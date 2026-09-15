/**
 * Deterministic mock dataset for the admin dashboard.
 *
 * Used when `ADMIN_MOCK=true`, and as an automatic development fallback when the
 * orchestrator cannot be reached. Every number is reproducible: the audit trail
 * is generated from a seeded PRNG and the aggregates are pinned to the figures of
 * the reference mock-up (docs/mockups.md §G).
 */
import {
  type AuditEvent,
  type AuditEventType,
  type AuditPage,
  type AuditQuery,
  type AuditStats,
  type Automation,
  type Escalation,
  type FeatureFlags,
  type Health,
  type Policy,
  type RiskLevel,
  type ApprovalStatus,
} from "@oao/shared";
import type { AdminUser } from "./types";

/* --------------------------------------------------------------------------- */
/*  Seeded PRNG (mulberry32) — same sequence on every process, every build.    */
/* --------------------------------------------------------------------------- */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rnd: () => number, list: readonly T[]): T =>
  list[Math.floor(rnd() * list.length)] as T;

/* --------------------------------------------------------------------------- */
/*  Period & people                                                            */
/* --------------------------------------------------------------------------- */

export const MOCK_PERIOD = { from: "2025-05-12T00:00:00.000Z", to: "2025-05-18T23:59:59.000Z" };
export const MOCK_TOTAL_AUDIT_RECORDS = 1247;
export const MOCK_TENANT = "ABC Capital";

export interface MockUser {
  id: string;
  email: string;
  displayName: string;
  roles: Array<"user" | "compliance" | "admin">;
  actions: number;
}

export const MOCK_USERS: MockUser[] = [
  { id: "u-jsmith", email: "jane.smith@northbridge.example", displayName: "Jane Smith", roles: ["user", "admin"], actions: 312 },
  { id: "u-mdubois", email: "marc.dubois@northbridge.example", displayName: "Marc Dubois", roles: ["user"], actions: 268 },
  { id: "u-sjohnson", email: "sarah.johnson@northbridge.example", displayName: "Sarah Johnson", roles: ["user"], actions: 224 },
  { id: "u-jcarter", email: "james.carter@northbridge.example", displayName: "James Carter", roles: ["user"], actions: 191 },
  { id: "u-lborg", email: "product.owner@northbridge.example", displayName: "Product Owner", roles: ["user", "compliance"], actions: 146 },
  { id: "u-techlead", email: "tech.lead@northbridge.example", displayName: "Tech Lead", roles: ["user", "admin"], actions: 106 },
];

const COMPLIANCE_TEAM = "Compliance Team";

const SUBJECTS: readonly string[] = [
  "Re: Mandate Approval – ABC Capital",
  "Q2 Vendor Risk Assessment – Review required",
  "FW: Mandate Documents – ABC Capital",
  "Project Horizon – Onboarding checklist",
  "Client A – Daily Reporting 16 May",
  "Re: Q2 Portfolio Update – ABC Capital",
  "KYC validation – Northbridge Capital",
  "Signed Account Mandate – outstanding",
  "Re: Investment Management Agreement",
  "Client A – Q2 Performance Report",
  "Northbridge / ABC Capital – Fee schedule",
  "Re: Custody transfer instructions",
  "Compliance review – external distribution",
  "Board pack – May 2025",
  "Re: Onboarding ABC Capital (Project Horizon)",
  "Weekly risk digest – Northbridge Capital",
];

const COUNTERPARTS: readonly string[] = [
  "james.carter@abccapital.com",
  "michael.brown@clientco.com",
  "sarah.johnson@northbridge.example",
  "operations@abccapital.com",
  "reporting@client-a.com",
  "legal@northbridge.example",
  "no-reply@secure-docs-review.net",
  "compliance@northbridge.example",
];

/* --------------------------------------------------------------------------- */
/*  Audit trail                                                                */
/* --------------------------------------------------------------------------- */

/** Base type mix; the first entry absorbs the rounding so the total is exactly 1,247. */
const TYPE_MIX: Array<[AuditEventType, number]> = [
  ["summary_generated", 556],
  ["draft_reply_generated", 190],
  ["actions_proposed", 85],
  ["action_approved", 90],
  ["action_executed", 58],
  ["chat_answered", 52],
  ["search_executed", 30],
  ["thread_synthesis_generated", 24],
  ["compliance_check", 38],
  ["compliance_alert", 37],
  ["compliance_escalated", 4],
  ["compliance_decision", 2],
  ["phishing_check", 20],
  ["automation_proposed", 12],
  ["automation_simulated", 10],
  ["automation_approved", 8],
  ["automation_rejected", 3],
  ["action_rejected", 8],
  ["action_failed", 3],
  ["label_applied", 10],
  ["emails_indexed", 4],
  ["policy_updated", 1],
  ["error", 2],
];

export const ALERT_CATEGORIES = [
  { code: "missing_classification_label", label: "Missing label", count: 13, share: 35.1 },
  { code: "external_recipient", label: "External recipient", count: 10, share: 27.0 },
  { code: "confidential_attachment", label: "Confidential content", count: 7, share: 18.9 },
  { code: "policy_violation", label: "Policy violation", count: 4, share: 10.8 },
  { code: "other", label: "Other", count: 3, share: 8.2 },
] as const;

const RISK_BY_TYPE: Partial<Record<AuditEventType, RiskLevel>> = {
  summary_generated: "low",
  draft_reply_generated: "low",
  search_executed: "low",
  chat_answered: "low",
  emails_indexed: "low",
  label_applied: "low",
  thread_synthesis_generated: "low",
  actions_proposed: "medium",
  action_approved: "medium",
  action_executed: "medium",
  action_rejected: "medium",
  action_failed: "high",
  automation_proposed: "medium",
  automation_simulated: "low",
  automation_approved: "medium",
  automation_rejected: "low",
  compliance_check: "medium",
  compliance_alert: "high",
  compliance_escalated: "high",
  compliance_decision: "high",
  phishing_check: "medium",
  policy_updated: "medium",
  error: "high",
};

const APPROVAL_BY_TYPE: Partial<Record<AuditEventType, ApprovalStatus>> = {
  summary_generated: "auto_approved",
  thread_synthesis_generated: "auto_approved",
  search_executed: "auto_approved",
  chat_answered: "auto_approved",
  emails_indexed: "auto_approved",
  draft_reply_generated: "auto_approved",
  compliance_check: "auto_approved",
  phishing_check: "auto_approved",
  label_applied: "approved",
  actions_proposed: "pending",
  action_approved: "approved",
  action_executed: "approved",
  action_rejected: "rejected",
  action_failed: "approved",
  automation_proposed: "pending",
  automation_simulated: "auto_approved",
  automation_approved: "approved",
  automation_rejected: "rejected",
  compliance_alert: "escalated",
  compliance_escalated: "escalated",
  compliance_decision: "approved",
  policy_updated: "approved",
  error: "n/a",
};

const AUTO_POLICY_BY_TYPE: Partial<Record<AuditEventType, string>> = {
  summary_generated: "Summarization",
  thread_synthesis_generated: "Thread synthesis",
  draft_reply_generated: "Draft generation",
  search_executed: "Conversational search",
  chat_answered: "Conversational search",
  compliance_check: "Pre-send compliance check",
  phishing_check: "Inbound anti-phishing",
  emails_indexed: "Mailbox indexing",
  automation_simulated: "Automation simulation",
};

const MODELS = ["qwen3-30b-a3b", "qwen3-30b-a3b", "qwen3-30b-a3b", "bge-m3"] as const;

function buildTypeSequence(): AuditEventType[] {
  const mix = TYPE_MIX.map(([t, n]) => [t, n] as [AuditEventType, number]);
  const sum = mix.reduce((acc, [, n]) => acc + n, 0);
  const first = mix[0] as [AuditEventType, number];
  first[1] += MOCK_TOTAL_AUDIT_RECORDS - sum;
  const out: AuditEventType[] = [];
  for (const [type, n] of mix) for (let i = 0; i < n; i += 1) out.push(type);
  return out;
}

/** Fisher-Yates with the seeded PRNG so the order is stable across runs. */
function shuffle<T>(rnd: () => number, list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function buildAuditEvents(): AuditEvent[] {
  const rnd = mulberry32(0x0a0a51);
  const types = shuffle(rnd, buildTypeSequence());
  const fromMs = Date.parse(MOCK_PERIOD.from);
  const spanMs = Date.parse(MOCK_PERIOD.to) - fromMs;

  // Category assignment for the 37 compliance alerts, in fixed proportions.
  const alertPool: string[] = [];
  for (const c of ALERT_CATEGORIES) for (let i = 0; i < c.count; i += 1) alertPool.push(c.code);
  let alertCursor = 0;

  const events: AuditEvent[] = types.map((type, index) => {
    // Working hours 07:00-19:00 UTC, weighted towards the morning.
    const dayIndex = Math.floor(rnd() * 7);
    const hour = 7 + Math.floor(Math.pow(rnd(), 1.6) * 12);
    const minute = Math.floor(rnd() * 60);
    const second = Math.floor(rnd() * 60);
    const ts = new Date(
      fromMs + dayIndex * 86400000 + ((hour * 60 + minute) * 60 + second) * 1000,
    );
    void spanMs;

    const user = MOCK_USERS[Math.floor(Math.pow(rnd(), 1.4) * MOCK_USERS.length)] as MockUser;
    const risk = RISK_BY_TYPE[type] ?? "low";
    const approvalStatus = APPROVAL_BY_TYPE[type] ?? "n/a";
    const subject = pick(rnd, SUBJECTS);
    const counterpart = pick(rnd, COUNTERPARTS);
    const latency = Math.round(380 + rnd() * 2600);
    const confidence = Math.round((0.62 + rnd() * 0.36) * 100) / 100;

    const details: Record<string, unknown> = {
      promptSha256: `sha256:${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0")}${index
        .toString(16)
        .padStart(6, "0")}`,
      responseSha256: `sha256:${Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, "0")}`,
      language: rnd() > 0.35 ? "en" : "fr",
      tokens: { prompt: 420 + Math.floor(rnd() * 2400), completion: 90 + Math.floor(rnd() * 600) },
    };

    if (type === "compliance_alert") {
      const category = alertPool[alertCursor % alertPool.length] as string;
      alertCursor += 1;
      details.category = category;
      details.verdict = category === "other" ? "warn" : "block";
      details.issues = [
        {
          code: category === "other" ? "large_distribution" : category,
          severity: category === "missing_classification_label" ? "medium" : "high",
          subject: counterpart,
        },
      ];
    }
    if (type === "compliance_escalated") {
      details.category = "policy_violation";
      details.escalationId = `esc-${1000 + index}`;
      details.assignedTo = COMPLIANCE_TEAM;
    }
    if (type === "phishing_check") {
      const score = Math.round(rnd() * 100) / 100;
      details.score = score;
      details.verdict = score > 0.75 ? "likely_phishing" : score > 0.45 ? "suspicious" : "clean";
      details.indicators =
        score > 0.45
          ? [{ code: "lookalike_domain", description: `${counterpart} resembles a known partner`, weight: 0.4 }]
          : [];
      if (score > 0.45) details.category = "phishing";
    }
    if (type === "automation_proposed" || type === "automation_approved" || type === "automation_simulated") {
      details.automationId = `auto-${(index % 3) + 1}`;
      details.estimatedMinutesSavedPerWeek = [18, 25, 12][index % 3];
    }
    if (type === "error") {
      details.error = { code: "llm_unavailable", message: "Upstream LLM timed out after 60000 ms" };
      details.degraded = true;
    }
    if (type.startsWith("action_")) {
      details.actionType = pick(rnd, [
        "draft_reply",
        "create_reminder",
        "categorize",
        "archive",
        "notify",
        "apply_label",
      ] as const);
    }

    const autoPolicy = AUTO_POLICY_BY_TYPE[type];
    if (autoPolicy && approvalStatus === "auto_approved") details.policy = autoPolicy;

    const approvedBy =
      approvalStatus === "approved" || approvalStatus === "rejected"
        ? pick(rnd, [MOCK_USERS[0]!.displayName, MOCK_USERS[4]!.displayName, user.displayName])
        : approvalStatus === "escalated"
          ? COMPLIANCE_TEAM
          : undefined;

    const event: AuditEvent = {
      id: `aud-${(index + 1).toString().padStart(5, "0")}`,
      timestamp: ts.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName },
      type,
      source: {
        label: subject,
        emailId: `AAMk${Math.floor(rnd() * 1e12).toString(36)}`,
        conversationId: `AAQk${Math.floor(rnd() * 1e10).toString(36)}`,
        counterpart,
      },
      riskLevel: risk,
      approvalStatus,
      confidence: type === "emails_indexed" ? undefined : confidence,
      model: pick(rnd, MODELS),
      latencyMs: latency,
      details,
      correlationId: `req-${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0")}-${index}`,
    };
    if (approvedBy) event.approvedBy = approvedBy;
    return event;
  });

  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events;
}

/* --------------------------------------------------------------------------- */
/*  Aggregates — pinned to the reference mock-up                               */
/* --------------------------------------------------------------------------- */

const KPI = {
  emailsSummarized: 8642,
  draftsGenerated: 2341,
  automationsProposed: 186,
  automationsApproved: 142,
  complianceAlerts: 37,
  errorsAvoided: 1216,
};

const KPI_DELTAS: Record<string, number> = {
  emailsSummarized: 12.4,
  draftsGenerated: 9.7,
  automationsProposed: 15.3,
  automationsApproved: 13.8,
  complianceAlerts: 8.3,
  errorsAvoided: 18.6,
};

/** Spread a total over 7 days with a stable weekday shape; last day takes the rest. */
function spread(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.round((total * w) / sum));
  const diff = total - out.reduce((a, b) => a + b, 0);
  out[out.length - 1] = (out[out.length - 1] as number) + diff;
  return out;
}

const DAY_WEIGHTS = [0.62, 1.32, 1.28, 1.21, 1.18, 1.09, 0.3] as const; // Mon 12 → Sun 18

function buildActivityOverTime(): AuditStats["activityOverTime"] {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.parse(MOCK_PERIOD.from) + i * 86400000).toISOString().slice(0, 10),
  );
  const summaries = spread(KPI.emailsSummarized, DAY_WEIGHTS);
  const drafts = spread(KPI.draftsGenerated, DAY_WEIGHTS);
  const automations = spread(KPI.automationsProposed, DAY_WEIGHTS);
  const alerts = spread(KPI.complianceAlerts, DAY_WEIGHTS);
  return days.map((date, i) => ({
    date: date as string,
    summaries: summaries[i] as number,
    drafts: drafts[i] as number,
    automations: automations[i] as number,
    complianceAlerts: alerts[i] as number,
  }));
}

const ACTIONS_BY_TYPE: AuditStats["actionsByType"] = [
  { type: "Summarization", count: 8642, share: 63.8 },
  { type: "Draft generation", count: 2341, share: 17.3 },
  { type: "Automation", count: 1300, share: 9.6 },
  { type: "Classification", count: 731, share: 5.4 },
  { type: "Other", count: 533, share: 3.9 },
];

export const MOCK_TOTAL_ACTIONS = ACTIONS_BY_TYPE.reduce((a, b) => a + b.count, 0); // 13,547

export function buildStats(period = MOCK_PERIOD): AuditStats {
  return {
    period,
    kpis: { ...KPI, deltas: { ...KPI_DELTAS } },
    activityOverTime: buildActivityOverTime(),
    actionsByType: ACTIONS_BY_TYPE.map((a) => ({ ...a })),
    complianceAlertsByCategory: ALERT_CATEGORIES.map((c) => ({
      category: c.label,
      count: c.count,
      share: c.share,
    })),
    automationsApprovalRate: { current: 76, previous: 68 },
    topUsers: MOCK_USERS.map((u) => ({ userId: u.id, displayName: u.displayName, actions: u.actions })),
    totalActions: MOCK_TOTAL_ACTIONS,
  };
}

/* --------------------------------------------------------------------------- */
/*  Automations                                                                */
/* --------------------------------------------------------------------------- */

function buildAutomations(): Automation[] {
  return [
    {
      id: "auto-1",
      name: "Client A daily reporting",
      description:
        "Every morning you save the Client A report, categorise the email and create a follow-up task.",
      trigger: {
        description: "Emails from Client A Reporting with attachments",
        conditions: { fromAddress: "reporting@client-a.com", hasAttachments: true, attachmentTypes: ["pdf", "xlsx"] },
      },
      steps: [
        { order: 1, type: "detect_attachment", title: "Detect attachment", description: "Detect email with attachment from Client A Reporting", parameters: {} },
        { order: 2, type: "save_attachment", title: "Save to Client A folder", description: "Save attachment to \\\\Reports\\Client A\\Daily Reports", parameters: { path: "\\\\Reports\\Client A\\Daily Reports" } },
        { order: 3, type: "categorize", title: "Apply category", description: "Categorize email as 'Client A – Reporting'", parameters: { category: "Client A – Reporting" } },
        { order: 4, type: "create_task", title: "Create reminder", description: "Create follow-up task to review the report", parameters: { dueInHours: 4 } },
      ],
      status: "simulated",
      stats: { occurrences: 63, perWeek: 5, estimatedMinutesPerOccurrence: 3.6, estimatedMinutesSavedPerWeek: 18 },
      confidence: 0.94,
      riskLevel: "low",
      createdAt: "2025-05-12T07:12:00.000Z",
      updatedAt: "2025-05-18T06:40:00.000Z",
      lastSimulation: {
        runAt: "2025-05-18T06:40:00.000Z",
        sampleSize: 10,
        checks: [
          { name: "Attachment detection accuracy", passed: true, detail: "10/10 attachments detected" },
          { name: "Correct folder mapping", passed: true, detail: "10/10 mapped to \\\\Reports\\Client A" },
          { name: "Category assignment", passed: true, detail: "10/10 categorised" },
          { name: "Reminder creation", passed: true, detail: "10/10 tasks created" },
        ],
        results: Array.from({ length: 10 }, (_, i) => ({
          emailId: `AAMkClientA${i + 1}`,
          subject: `Client A – Daily Reporting ${9 + i} May`,
          wouldApply: i !== 7,
          stepsPreview: ["Detect attachment", "Save to \\\\Reports\\Client A", "Categorize", "Create task"],
        })),
      },
    },
    {
      id: "auto-2",
      name: "Mandate documents to Legal",
      description:
        "Mandate PDFs from ABC Capital are flagged, labelled Confidential and forwarded to the Legal review queue.",
      trigger: {
        description: "Emails from abccapital.com whose subject contains 'Mandate' with a PDF attached",
        conditions: { fromDomain: "abccapital.com", subjectContains: "Mandate", hasAttachments: true, attachmentTypes: ["pdf"] },
      },
      steps: [
        { order: 1, type: "detect_attachment", title: "Detect mandate PDF", description: "Detect PDF attachment named like a mandate", parameters: {} },
        { order: 2, type: "apply_label", title: "Apply Confidential label", description: "Apply the 'Confidential' sensitivity label", parameters: { label: "Confidential" } },
        { order: 3, type: "flag", title: "Flag for follow-up", description: "Flag the email for the legal review queue", parameters: {} },
        { order: 4, type: "notify", title: "Notify Legal", description: "Notify legal@northbridge.example that a mandate arrived", parameters: { to: "legal@northbridge.example" } },
      ],
      status: "active",
      stats: { occurrences: 41, perWeek: 3.5, estimatedMinutesPerOccurrence: 7.1, estimatedMinutesSavedPerWeek: 25 },
      confidence: 0.88,
      riskLevel: "medium",
      createdAt: "2025-05-06T09:05:00.000Z",
      updatedAt: "2025-05-16T14:22:00.000Z",
      lastSimulation: {
        runAt: "2025-05-14T09:30:00.000Z",
        sampleSize: 10,
        checks: [
          { name: "Mandate detection", passed: true, detail: "9/10 detected" },
          { name: "Label application", passed: true, detail: "10/10 labelled Confidential" },
          { name: "Legal notification", passed: true, detail: "10/10 notified" },
          { name: "No external forward", passed: true, detail: "0 external recipients added" },
        ],
        results: Array.from({ length: 8 }, (_, i) => ({
          emailId: `AAMkMandate${i + 1}`,
          subject: i % 3 === 0 ? "Re: Mandate Approval – ABC Capital" : "FW: Mandate Documents – ABC Capital",
          wouldApply: i !== 4,
          stepsPreview: ["Detect mandate PDF", "Apply Confidential", "Flag", "Notify Legal"],
        })),
      },
    },
    {
      id: "auto-3",
      name: "Weekly risk digest archive",
      description: "The weekly risk digest is archived and categorised once read.",
      trigger: {
        description: "Emails from compliance@northbridge.example whose subject contains 'risk digest'",
        conditions: { fromAddress: "compliance@northbridge.example", subjectContains: "risk digest", hasAttachments: false },
      },
      steps: [
        { order: 1, type: "categorize", title: "Apply category", description: "Categorize as 'Risk – Weekly digest'", parameters: { category: "Risk – Weekly digest" } },
        { order: 2, type: "archive", title: "Archive", description: "Move the email to the Risk archive folder", parameters: { folder: "Risk/Digests" } },
      ],
      status: "proposed",
      stats: { occurrences: 11, perWeek: 1, estimatedMinutesPerOccurrence: 12, estimatedMinutesSavedPerWeek: 12 },
      confidence: 0.71,
      riskLevel: "low",
      createdAt: "2025-05-17T08:02:00.000Z",
      updatedAt: "2025-05-17T08:02:00.000Z",
    },
  ];
}

/* --------------------------------------------------------------------------- */
/*  Escalations                                                                */
/* --------------------------------------------------------------------------- */

function buildEscalations(): Escalation[] {
  return [
    {
      id: "esc-2051",
      status: "pending",
      requestedBy: "marc.dubois@northbridge.example",
      requestedAt: "2025-05-18T09:24:00.000Z",
      reason:
        "Outbound email carries the Q2 performance report to an external recipient without a classification label.",
      issues: [
        { id: "i-1", code: "external_recipient", title: "External recipient detected", description: "michael.brown@clientco.com is outside your organization.", severity: "high", subject: "michael.brown@clientco.com" },
        { id: "i-2", code: "confidential_attachment", title: "Confidential attachment", description: "Client A – Q2 Performance Report.pdf is classified as confidential.", severity: "high", subject: "Client A – Q2 Performance Report.pdf" },
        { id: "i-3", code: "missing_classification_label", title: "Missing classification label", description: "This email is not labeled. Policy requires a classification.", severity: "medium" },
        { id: "i-4", code: "sensitive_client_information", title: "Sensitive client information found", description: "Content may contain sensitive client or portfolio information.", severity: "high" },
      ],
    },
    {
      id: "esc-2048",
      status: "pending",
      requestedBy: "sarah.johnson@northbridge.example",
      requestedAt: "2025-05-17T16:05:00.000Z",
      reason: "Mandate documents forwarded to a distribution list of 14 external recipients.",
      issues: [
        { id: "i-5", code: "large_distribution", title: "Large distribution", description: "14 external recipients exceed the threshold of 10.", severity: "medium", subject: "14 recipients" },
        { id: "i-6", code: "confidential_attachment", title: "Confidential attachment", description: "ABC Capital Mandate.pdf is classified as confidential.", severity: "high", subject: "ABC Capital Mandate.pdf" },
      ],
    },
    {
      id: "esc-2039",
      status: "approved",
      requestedBy: "james.carter@northbridge.example",
      requestedAt: "2025-05-15T11:12:00.000Z",
      reason: "Custody transfer instructions sent to a newly registered counterpart domain.",
      decidedBy: "Product Owner",
      decidedAt: "2025-05-15T13:40:00.000Z",
      decisionComment: "Counterpart verified with the operations team by phone. Approved for this send only.",
      issues: [
        { id: "i-7", code: "suspicious_recipient_domain", title: "Suspicious recipient domain", description: "secure-docs-review.net was first seen 3 days ago.", severity: "high", subject: "no-reply@secure-docs-review.net" },
      ],
    },
    {
      id: "esc-2031",
      status: "rejected",
      requestedBy: "marc.dubois@northbridge.example",
      requestedAt: "2025-05-13T08:47:00.000Z",
      reason: "Portfolio extract with client IBANs to a personal mailbox.",
      decidedBy: "Jane Smith",
      decidedAt: "2025-05-13T09:15:00.000Z",
      decisionComment: "Rejected: sending client IBANs to a personal address breaches the data minimisation policy.",
      issues: [
        { id: "i-8", code: "sensitive_client_information", title: "Sensitive client information found", description: "3 IBAN patterns detected in the body.", severity: "high" },
        { id: "i-9", code: "policy_violation", title: "Policy violation", description: "Recipient domain is a public webmail provider.", severity: "high", subject: "m.dubois@gmail.com" },
      ],
    },
  ];
}

/** Draft context shown on the approval cards. Not part of `Escalation` in the contract. */
export const MOCK_ESCALATION_DRAFTS: Record<
  string,
  { subject: string; to: string[]; attachments: string[] }
> = {
  "esc-2051": {
    subject: "Client A – Q2 Performance Report",
    to: ["michael.brown@clientco.com", "james.carter@abccapital.com"],
    attachments: ["Client A – Q2 Performance Report.pdf"],
  },
  "esc-2048": {
    subject: "FW: Mandate Documents – ABC Capital",
    to: ["operations@abccapital.com", "+ 13 more"],
    attachments: ["ABC Capital Mandate.pdf", "Fee schedule.xlsx"],
  },
  "esc-2039": {
    subject: "Re: Custody transfer instructions",
    to: ["no-reply@secure-docs-review.net"],
    attachments: [],
  },
  "esc-2031": {
    subject: "Portfolio extract – May 2025",
    to: ["m.dubois@gmail.com"],
    attachments: ["portfolio-extract.csv"],
  },
};

/* --------------------------------------------------------------------------- */
/*  Policy, users, features, health                                            */
/* --------------------------------------------------------------------------- */

export function defaultPolicy(): Policy {
  return {
    internalDomains: ["northbridge.example", "northbridgecapital.ch"],
    confidentialPatterns: ["confidential", "restricted", "internal only", "q[0-9] performance report"],
    requiredClassificationLabels: ["Public", "Internal", "Confidential", "Strictly Confidential"],
    sensitiveDataPatterns: [
      { name: "IBAN", pattern: "\\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\\b", severity: "high" },
      { name: "Portfolio account number", pattern: "\\b[0-9]{3}\\.[0-9]{3}\\.[0-9]{3}\\b", severity: "high" },
      { name: "Swiss AVS number", pattern: "\\b756\\.[0-9]{4}\\.[0-9]{4}\\.[0-9]{2}\\b", severity: "medium" },
      { name: "Credit card", pattern: "\\b(?:[0-9]{4}[ -]?){3}[0-9]{4}\\b", severity: "high" },
    ],
    largeDistributionThreshold: 10,
    complianceApprovalFor: ["escalate_compliance", "remove_attachment", "request_approval"],
    approvalRequiredFrom: "medium",
    blockOnHighRisk: true,
    updatedAt: "2025-05-16T10:32:00.000Z",
    updatedBy: "jane.smith@northbridge.example",
  };
}

const LAST_ACTIVITY: Record<string, string> = {
  "u-jsmith": "2025-05-18T17:42:00.000Z",
  "u-mdubois": "2025-05-18T16:58:00.000Z",
  "u-sjohnson": "2025-05-18T15:12:00.000Z",
  "u-jcarter": "2025-05-18T11:37:00.000Z",
  "u-lborg": "2025-05-17T18:04:00.000Z",
  "u-techlead": "2025-05-16T09:21:00.000Z",
};

export function buildUsers(): AdminUser[] {
  return MOCK_USERS.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    roles: u.roles,
    tenantId: "abc-capital",
    actions: u.actions,
    lastActivityAt: LAST_ACTIVITY[u.id] as string,
  }));
}

export function mockFeatures(): FeatureFlags {
  return {
    graphEnabled: false,
    embeddingsEnabled: true,
    llmProvider: "openai-compatible",
    llmModel: "qwen3-30b-a3b",
    authMode: "dev",
    version: "0.1.0",
  };
}

export function mockHealth(): Health {
  return {
    status: "degraded",
    checks: {
      database: { status: "ok", detail: "postgres 16 + pgvector 0.7" },
      llm: { status: "ok", detail: "qwen3-30b-a3b @ gpu-node.northbridge.local" },
      embeddings: { status: "ok", detail: "bge-m3, 1024 dimensions" },
      graph: { status: "degraded", detail: "GRAPH_ENABLED=false — server actions fall back to the client" },
    },
    version: "0.1.0",
    timestamp: "2025-05-18T23:59:00.000Z",
  };
}

/* --------------------------------------------------------------------------- */
/*  In-memory store (mutations from the route handlers land here)              */
/* --------------------------------------------------------------------------- */

interface MockStore {
  events: AuditEvent[];
  automations: Automation[];
  escalations: Escalation[];
  policy: Policy;
  users: AdminUser[];
}

const globalStore = globalThis as unknown as { __oaoAdminMock?: MockStore };

export function store(): MockStore {
  if (!globalStore.__oaoAdminMock) {
    globalStore.__oaoAdminMock = {
      events: buildAuditEvents(),
      automations: buildAutomations(),
      escalations: buildEscalations(),
      policy: defaultPolicy(),
      users: buildUsers(),
    };
  }
  return globalStore.__oaoAdminMock;
}

/* --------------------------------------------------------------------------- */
/*  Query helpers                                                              */
/* --------------------------------------------------------------------------- */

export function filterEvents(query: Partial<AuditQuery>): AuditEvent[] {
  const { from, to, userId, type, riskLevel, approvalStatus, search } = query;
  const needle = search?.trim().toLowerCase();
  return store().events.filter((e) => {
    if (from && e.timestamp < from) return false;
    if (to && e.timestamp > to) return false;
    if (userId && e.user.id !== userId) return false;
    if (type && e.type !== type) return false;
    if (riskLevel && e.riskLevel !== riskLevel) return false;
    if (approvalStatus && e.approvalStatus !== approvalStatus) return false;
    if (needle) {
      const haystack = [
        e.source?.label,
        e.source?.counterpart,
        e.user.email,
        e.user.displayName,
        e.type,
        e.correlationId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function mockAuditPage(query: Partial<AuditQuery>): AuditPage {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const all = filterEvents(query);
  return {
    items: all.slice((page - 1) * pageSize, page * pageSize),
    total: all.length,
    page,
    pageSize,
  };
}

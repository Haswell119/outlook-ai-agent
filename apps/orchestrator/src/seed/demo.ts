import type { AuditEvent, AuditEventType, RiskLevel, UserActionEvent } from "@oao/shared";
import { DEFAULT_POLICY } from "@oao/shared";
import type { AuthenticatedUser } from "../auth/identity.js";
import type { Container } from "../container.js";
import { automationFingerprint } from "../domain/automation/detector.js";
import type { StoredAutomation, StoredEscalation } from "../ports/repositories.js";
import { newId } from "../util/ids.js";
import { DEMO_PEOPLE, sampleEmails } from "./emails.js";

/**
 * Realistic demo data: ~60 audit events over 14 days across 5 users, 3 automations
 * in different statuses, 2 escalations, 40 indexed emails, and a recurring routine
 * in the user-action history so that "Detect" finds something.
 * Works with both the memory and the Postgres repositories.
 */
export interface SeedResult {
  users: number;
  auditEvents: number;
  emailsIndexed: number;
  automations: number;
  escalations: number;
  userActionEvents: number;
}

const USERS = [
  { id: "dev.user@northbridge.example", email: "dev.user@northbridge.example", displayName: "Dev User" },
  { id: "jane.smith@northbridge.example", email: "jane.smith@northbridge.example", displayName: "Jane Smith" },
  { id: "marc.dubois@northbridge.example", email: "marc.dubois@northbridge.example", displayName: "Marc Dubois" },
  { id: "sophie.martin@northbridge.example", email: "sophie.martin@northbridge.example", displayName: "Sophie Martin" },
  { id: "compliance@northbridge.example", email: "compliance@northbridge.example", displayName: "Compliance Team" },
];

/** Deterministic pseudo-random generator so the demo looks the same every start. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export async function seedDemo(c: Container, now = new Date()): Promise<SeedResult> {
  const { repos } = c.deps;
  const rand = rng(42);
  const emails = sampleEmails(now);
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)]!;

  // Policy
  if (!(await repos.policy.get())) await repos.policy.put({ ...DEFAULT_POLICY, updatedAt: now.toISOString(), updatedBy: "seed" });

  // Emails indexed for the default dev identity and for Jane (the RM of the story).
  let emailsIndexed = 0;
  for (const u of [USERS[0]!, USERS[1]!]) {
    const user: AuthenticatedUser = { ...u, roles: ["user"], via: "dev-headers" };
    const r = await c.services.indexEmails.index({ user, language: "en" }, emails, { audit: false });
    emailsIndexed += r.indexed;
  }

  // Audit events: ~60 over the last 14 days.
  const types: Array<{ type: AuditEventType; risk: RiskLevel; approval: AuditEvent["approvalStatus"]; weight: number }> = [
    { type: "summary_generated", risk: "low", approval: "auto_approved", weight: 22 },
    { type: "draft_reply_generated", risk: "low", approval: "pending", weight: 10 },
    { type: "thread_synthesis_generated", risk: "low", approval: "auto_approved", weight: 5 },
    { type: "chat_answered", risk: "low", approval: "auto_approved", weight: 6 },
    { type: "actions_proposed", risk: "medium", approval: "pending", weight: 4 },
    { type: "action_approved", risk: "medium", approval: "approved", weight: 4 },
    { type: "action_executed", risk: "low", approval: "approved", weight: 3 },
    { type: "compliance_check", risk: "medium", approval: "auto_approved", weight: 4 },
    { type: "compliance_alert", risk: "high", approval: "escalated", weight: 3 },
    { type: "phishing_check", risk: "high", approval: "auto_approved", weight: 2 },
    { type: "automation_proposed", risk: "low", approval: "pending", weight: 2 },
    { type: "automation_approved", risk: "low", approval: "approved", weight: 1 },
    { type: "label_applied", risk: "low", approval: "approved", weight: 2 },
  ];
  const weighted = types.flatMap((t) => Array.from({ length: t.weight }, () => t));
  const issueCodes = ["missing_classification_label", "external_recipient", "confidential_attachment", "sensitive_client_information", "policy_violation"];
  let auditEvents = 0;
  for (let i = 0; i < 62; i++) {
    const t = pick(weighted);
    const user = pick(USERS);
    const email = pick(emails);
    const ts = new Date(now.getTime() - rand() * 14 * 86_400_000).toISOString();
    const details: Record<string, unknown> = { seeded: true, promptHash: newId().replace(/-/g, ""), responseHash: newId().replace(/-/g, "") };
    if (t.type === "compliance_alert" || t.type === "compliance_check") details.issues = [{ code: pick(issueCodes), severity: t.risk }, ...(rand() > 0.5 ? [{ code: pick(issueCodes), severity: "medium" }] : [])];
    const event: AuditEvent = {
      id: newId(),
      timestamp: ts,
      user,
      type: t.type,
      source: { label: email.subject, emailId: email.id, conversationId: email.conversationId, counterpart: email.from?.address },
      riskLevel: t.risk,
      approvalStatus: t.approval,
      approvedBy: t.approval === "approved" ? user.email : t.approval === "escalated" ? "Compliance Team" : undefined,
      confidence: Number((0.7 + rand() * 0.28).toFixed(2)),
      model: c.deps.llm.model,
      latencyMs: Math.round(400 + rand() * 2500),
      details,
      correlationId: newId(),
    };
    await repos.audit.append(event);
    auditEvents++;
  }

  // Escalations: one pending, one approved.
  const escalations: StoredEscalation[] = [
    { id: newId(), userId: USERS[1]!.id, status: "pending", requestedBy: USERS[1]!.email, requestedAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(), reason: "Sending the May performance report to ABC Capital (external) with a confidential attachment.", issues: [{ id: "e1", code: "confidential_attachment", title: "Confidential attachment", description: "ABC Capital – Performance Report May 2025.pdf is classified as confidential.", severity: "high", subject: "ABC Capital – Performance Report May 2025.pdf" }, { id: "e2", code: "external_recipient", title: "External recipient detected", description: "james.carter@abccapital.com is outside your organization.", severity: "high", subject: "james.carter@abccapital.com" }] },
    { id: newId(), userId: USERS[2]!.id, status: "approved", requestedBy: USERS[2]!.email, requestedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(), reason: "Share the Q2 mandate review deck with the custodian.", decidedBy: "compliance@northbridge.example", decidedAt: new Date(now.getTime() - 2.5 * 86_400_000).toISOString(), decisionComment: "Approved: recipient is a contracted custodian under NDA.", issues: [{ id: "e3", code: "external_recipient", title: "External recipient detected", description: "custody@swissbank-custody.ch is outside your organization.", severity: "medium", subject: "custody@swissbank-custody.ch" }] },
  ];
  for (const e of escalations) await repos.escalations.create(e);

  // User action events: Jane / dev user process every ABC Capital daily report the same way (routine to detect).
  const routineEmails = emails.filter((e) => e.from?.address === DEMO_PEOPLE.reports.address);
  const actionEvents: Array<UserActionEvent & { id: string; userId: string }> = [];
  for (const u of [USERS[0]!, USERS[1]!]) {
    for (const e of routineEmails) {
      const base = Date.parse(e.receivedAt!) + 30 * 60_000;
      const emailRef = { id: e.id, conversationId: e.conversationId, fromAddress: e.from!.address, fromDomain: "abccapital.com", subject: e.subject, hasAttachments: true, attachmentTypes: ["xlsx"] };
      const seq: Array<[UserActionEvent["type"], Record<string, unknown>]> = [
        ["open_email", {}],
        ["save_attachment", { folder: "\\\\Reports\\ABC Capital\\Daily Reports" }],
        ["categorize", { category: "ABC Capital – Reporting" }],
        ["create_reminder", { title: "Review ABC Capital daily report" }],
      ];
      seq.forEach(([type, parameters], j) => actionEvents.push({ id: newId(), userId: u.id, type, occurredAt: new Date(base + j * 60_000).toISOString(), email: emailRef, parameters }));
    }
  }
  await repos.userActionEvents.append(actionEvents);

  // Automations in three statuses.
  const mk = (userId: string, status: StoredAutomation["status"], name: string, fromDomain: string, folder: string, category: string, extra: Partial<StoredAutomation> = {}): StoredAutomation => {
    const trigger = { description: `Emails from ${fromDomain} with attachments`, conditions: { fromDomain, hasAttachments: true } };
    const steps: StoredAutomation["steps"] = [
      { order: 1, type: "detect_attachment", title: "Detect attachment", description: `Detect email with attachment from ${fromDomain}`, parameters: {} },
      { order: 2, type: "save_attachment", title: "Save attachment", description: `Save attachment to ${folder}`, parameters: { folder } },
      { order: 3, type: "categorize", title: "Apply category", description: `Categorize email as '${category}'`, parameters: { category } },
      { order: 4, type: "create_reminder", title: "Create reminder", description: "Create follow-up task to review the report", parameters: { title: `Review ${category}` } },
    ];
    const createdAt = new Date(now.getTime() - 5 * 86_400_000).toISOString();
    return { id: newId(), userId, fingerprint: automationFingerprint(trigger, steps), name, description: `You do this 5 days a week, ~18 minutes total.`, trigger, steps, status, stats: { occurrences: 7, perWeek: 5, estimatedMinutesPerOccurrence: 3.5, estimatedMinutesSavedPerWeek: 17.5 }, confidence: 0.94, riskLevel: "low", createdAt, updatedAt: createdAt, ...extra };
  };
  const sim = { runAt: new Date(now.getTime() - 4 * 86_400_000).toISOString(), sampleSize: 3, checks: [{ name: "Attachment detection accuracy", passed: true, detail: "3/3" }, { name: "Correct folder mapping", passed: true, detail: "\\\\Reports\\Meridian" }, { name: "Category assignment", passed: true, detail: "Meridian – Reporting" }, { name: "Reminder creation", passed: true, detail: "3 reminder(s) would be created" }], results: routineEmails.slice(0, 3).map((e) => ({ emailId: e.id, subject: e.subject, wouldApply: true, stepsPreview: ["Save attachment", "Categorize", "Create reminder"] })) };
  const automations = [
    mk(USERS[1]!.id, "proposed", "abccapital.com: Save → Categorize → Remind", "abccapital.com", "\\\\Reports\\ABC Capital\\Daily Reports", "ABC Capital – Reporting"),
    mk(USERS[2]!.id, "simulated", "meridian-partners.com: Save → Categorize → Remind", "meridian-partners.com", "\\\\Reports\\Meridian", "Meridian – Reporting", { lastSimulation: sim }),
    mk(USERS[3]!.id, "active", "atlas-holding.ch: Save → Categorize → Remind", "atlas-holding.ch", "\\\\Reports\\Atlas", "Atlas – Reporting", { lastSimulation: sim }),
  ];
  for (const a of automations) await repos.automations.save(a);

  return { users: USERS.length, auditEvents, emailsIndexed, automations: automations.length, escalations: escalations.length, userActionEvents: actionEvents.length };
}

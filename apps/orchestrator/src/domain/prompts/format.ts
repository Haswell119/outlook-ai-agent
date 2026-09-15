import type { EmailContext, Language, ThreadContext } from "@oao/shared";
import { truncate } from "../../util/text.js";

/** Max characters of body sent to the model per email. */
export const MAX_BODY_CHARS = 6000;

export const langName = (l: Language) => (l === "fr" ? "French (français)" : "English");

/**
 * Structured, greppable rendering of an email. The mock provider parses this
 * format back, so keep the field labels stable.
 */
export function formatEmail(email: EmailContext, index?: number): string {
  const addr = (a: { name?: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const lines = [
    index !== undefined ? `### MESSAGE ${index}` : "### EMAIL",
    `Id: ${email.id}`,
    `Subject: ${email.subject}`,
    `From: ${email.from ? addr(email.from) : "(unknown)"}`,
    `To: ${email.to.map(addr).join(", ") || "(none)"}`,
  ];
  if (email.cc.length) lines.push(`Cc: ${email.cc.map(addr).join(", ")}`);
  if (email.receivedAt || email.sentAt) lines.push(`Date: ${email.receivedAt ?? email.sentAt}`);
  if (email.importance) lines.push(`Importance: ${email.importance}`);
  if (email.sensitivityLabel) lines.push(`Label: ${email.sensitivityLabel}`);
  lines.push(`Attachments: ${email.attachments.length ? email.attachments.map((a) => a.name).join(", ") : "(none)"}`);
  lines.push("Body:");
  lines.push(truncate(email.body, MAX_BODY_CHARS));
  for (const a of email.attachments.filter((x) => x.textContent)) {
    lines.push(`Attachment text (${a.name}):`);
    lines.push(truncate(a.textContent ?? "", 2000));
  }
  lines.push(index !== undefined ? `### END MESSAGE ${index}` : "### END EMAIL");
  return lines.join("\n");
}

export function formatThread(thread: ThreadContext, maxMessages = 25): string {
  const msgs = [...thread.messages].sort((a, b) => (a.receivedAt ?? a.sentAt ?? "").localeCompare(b.receivedAt ?? b.sentAt ?? "")).slice(-maxMessages);
  return [`### THREAD "${thread.subject}" (${msgs.length} messages, oldest first)`, ...msgs.map((m, i) => formatEmail(m, i + 1))].join("\n\n");
}

export const SYSTEM_BASE = (lang: Language) =>
  [
    "You are the Outlook AI Orchestrator, an assistant for a Swiss wealth-management firm (Longbow Finance).",
    "You never send emails, never delete anything and never invent facts that are not in the provided content.",
    "Be concise, factual and professional. Client information is confidential.",
    `Write every human-readable field in ${langName(lang)}.`,
    "Return ONLY a single JSON object matching the requested schema — no markdown, no commentary.",
  ].join(" ");

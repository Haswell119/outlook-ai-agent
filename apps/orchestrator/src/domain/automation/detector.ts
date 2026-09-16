import type { Automation, AutomationStep, AutomationTrigger, Language, RiskLevel, UserActionEvent } from "@oao/shared";
import { sha256 } from "../../util/hash.js";

/**
 * Routine detection: mine the user's action history for recurring ordered
 * sequences of ≥ 2 action types on emails sharing the same trigger
 * (sender domain / address + attachment presence), ≥ 3 occurrences in 30 days.
 */

export type StepType = AutomationStep["type"];

/** Minutes a human spends per step type (used for the "time saved" estimate). */
export const MINUTES_PER_STEP: Record<string, number> = {
  detect_attachment: 0,
  save_attachment: 2,
  download_attachment: 2,
  categorize: 0.5,
  classify_email: 0.5,
  create_reminder: 1,
  create_task: 1,
  move_to_folder: 0.5,
  archive: 0.5,
  flag: 0.25,
  apply_label: 0.5,
  notify: 0.5,
  draft_reply: 3,
  request_document: 2,
};

const IGNORED: ReadonlySet<UserActionEvent["type"]> = new Set(["open_email", "reply", "forward"]);

export interface DetectorOptions {
  now?: Date;
  windowDays?: number;
  minOccurrences?: number;
  language?: Language;
}

interface Group {
  key: string;
  trigger: AutomationTrigger["conditions"];
  /** emailId → ordered action types */
  sequences: Map<string, { types: string[]; at: string; subject?: string; params: Record<string, unknown>[] }>;
}

function mapEventType(t: UserActionEvent["type"]): StepType {
  if (t === "download_attachment") return "save_attachment";
  return t as StepType;
}

export function detectAutomations(events: UserActionEvent[], opts: DetectorOptions = {}): Omit<Automation, "id" | "createdAt" | "updatedAt">[] {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const minOcc = opts.minOccurrences ?? 3;
  const lang = opts.language ?? "en";
  const since = now.getTime() - windowDays * 86_400_000;

  const groups = new Map<string, Group>();
  for (const ev of events) {
    if (IGNORED.has(ev.type)) continue;
    const at = Date.parse(ev.occurredAt);
    if (Number.isNaN(at) || at < since || at > now.getTime() + 60_000) continue;
    const domain = (ev.email.fromDomain ?? ev.email.fromAddress?.split("@")[1] ?? "").toLowerCase();
    const address = ev.email.fromAddress?.toLowerCase();
    const hasAttachments = Boolean(ev.email.hasAttachments);
    const triggerKey = `${domain || address || "unknown"}|${hasAttachments}`;
    let group = groups.get(triggerKey);
    if (!group) {
      group = { key: triggerKey, trigger: { ...(domain ? { fromDomain: domain } : { fromAddress: address }), hasAttachments }, sequences: new Map() };
      groups.set(triggerKey, group);
    }
    const seq = group.sequences.get(ev.email.id) ?? { types: [], at: ev.occurredAt, subject: ev.email.subject, params: [] };
    const type = mapEventType(ev.type);
    if (seq.types[seq.types.length - 1] !== type) {
      seq.types.push(type);
      seq.params.push(ev.parameters ?? {});
    }
    if (ev.occurredAt < seq.at) seq.at = ev.occurredAt;
    group.sequences.set(ev.email.id, seq);
  }

  const proposals: Omit<Automation, "id" | "createdAt" | "updatedAt">[] = [];
  for (const group of groups.values()) {
    // Count identical ordered sequences (length ≥ 2).
    const bySignature = new Map<string, { count: number; params: Record<string, unknown>[]; subjects: string[]; dates: number[] }>();
    for (const seq of group.sequences.values()) {
      if (seq.types.length < 2) continue;
      const sig = seq.types.join(">");
      const entry = bySignature.get(sig) ?? { count: 0, params: seq.params, subjects: [], dates: [] };
      entry.count++;
      if (seq.subject) entry.subjects.push(seq.subject);
      entry.dates.push(Date.parse(seq.at));
      bySignature.set(sig, entry);
    }
    // Keep the most frequent signature per trigger.
    const best = Array.from(bySignature.entries()).sort((a, b) => b[1].count - a[1].count)[0];
    if (!best || best[1].count < minOcc) continue;
    const [sig, info] = best;
    const types = sig.split(">") as StepType[];
    const subjectContains = commonSubjectToken(info.subjects);
    const trigger: AutomationTrigger = {
      description: describeTrigger(group.trigger, subjectContains, lang),
      conditions: { ...group.trigger, ...(subjectContains ? { subjectContains } : {}) },
    };
    const steps = buildSteps(types, info.params, group.trigger, lang);
    const minutesPerOccurrence = steps.reduce((acc, s) => acc + (MINUTES_PER_STEP[s.type] ?? 0.5), 0);
    const spanDays = Math.max(7, (Math.max(...info.dates) - Math.min(...info.dates)) / 86_400_000);
    const perWeek = Number(((info.count / spanDays) * 7).toFixed(1));
    const riskLevel: RiskLevel = types.some((t) => t === "move_to_folder" || t === "archive") ? "medium" : "low";
    const confidence = Math.min(0.97, Number((0.6 + Math.min(info.count, 10) * 0.035 + (info.count / Math.max(1, group.sequences.size)) * 0.1).toFixed(2)));
    proposals.push({
      name: automationName(group.trigger, types, lang),
      description:
        lang === "fr"
          ? `Vous effectuez cette séquence ${info.count} fois sur ${windowDays} jours (~${Math.round(minutesPerOccurrence * perWeek)} min/semaine).`
          : `You do this ${info.count} times in the last ${windowDays} days (~${Math.round(minutesPerOccurrence * perWeek)} minutes per week).`,
      trigger,
      steps,
      status: "proposed",
      stats: {
        occurrences: info.count,
        perWeek,
        estimatedMinutesPerOccurrence: minutesPerOccurrence,
        estimatedMinutesSavedPerWeek: Number((minutesPerOccurrence * perWeek).toFixed(1)),
      },
      confidence,
      riskLevel,
    });
  }
  return proposals.sort((a, b) => b.stats.occurrences - a.stats.occurrences);
}

/** Deterministic fingerprint of trigger + ordered step types (dedup on upsert). */
export function automationFingerprint(trigger: AutomationTrigger, steps: AutomationStep[]): string {
  const c = trigger.conditions;
  return sha256(`${c.fromDomain ?? ""}|${c.fromAddress ?? ""}|${c.subjectContains ?? ""}|${c.hasAttachments ?? ""}|${steps.map((s) => s.type).join(">")}`).slice(0, 32);
}

function commonSubjectToken(subjects: string[]): string | undefined {
  if (subjects.length < 2) return undefined;
  const tokenSets = subjects.map((s) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((t) => !["re", "fw", "fwd", "tr"].includes(t))));
  const first = tokenSets[0];
  if (!first) return undefined;
  // Single longest token shared by every subject (a literal substring match must hold in simulations).
  const common = Array.from(first).filter((t) => tokenSets.every((set) => set.has(t)));
  return common.length ? common.sort((a, b) => b.length - a.length)[0] : undefined;
}

function describeTrigger(c: AutomationTrigger["conditions"], subjectContains: string | undefined, lang: Language): string {
  const who = c.fromDomain ? (lang === "fr" ? `de ${c.fromDomain}` : `from ${c.fromDomain}`) : c.fromAddress ? (lang === "fr" ? `de ${c.fromAddress}` : `from ${c.fromAddress}`) : "";
  const att = c.hasAttachments ? (lang === "fr" ? " avec pièces jointes" : " with attachments") : "";
  const subj = subjectContains ? (lang === "fr" ? ` dont l'objet contient « ${subjectContains} »` : ` whose subject contains "${subjectContains}"`) : "";
  return lang === "fr" ? `Emails ${who}${att}${subj}` : `Emails ${who}${att}${subj}`;
}

function automationName(c: AutomationTrigger["conditions"], types: StepType[], lang: Language): string {
  const source = c.fromDomain ?? c.fromAddress ?? "sender";
  const verbs = types.map((t) => STEP_TEXT[t]?.[lang].short ?? t).join(" → ");
  return lang === "fr" ? `${source} : ${verbs}` : `${source}: ${verbs}`;
}

const STEP_TEXT: Record<string, { en: { short: string; title: string; description: string }; fr: { short: string; title: string; description: string } }> = {
  detect_attachment: { en: { short: "Detect", title: "Detect attachment", description: "Detect email with attachment{from}" }, fr: { short: "Détecter", title: "Détecter la pièce jointe", description: "Détecter l'email avec pièce jointe{from}" } },
  save_attachment: { en: { short: "Save", title: "Save attachment", description: "Save attachment to {folder}" }, fr: { short: "Enregistrer", title: "Enregistrer la pièce jointe", description: "Enregistrer la pièce jointe dans {folder}" } },
  categorize: { en: { short: "Categorize", title: "Apply category", description: "Categorize email as '{category}'" }, fr: { short: "Catégoriser", title: "Appliquer une catégorie", description: "Catégoriser l'email « {category} »" } },
  classify_email: { en: { short: "Classify", title: "Classify email", description: "Classify email as '{category}'" }, fr: { short: "Classer", title: "Classer l'email", description: "Classer l'email « {category} »" } },
  create_reminder: { en: { short: "Remind", title: "Create reminder", description: "Create follow-up reminder to review the email" }, fr: { short: "Rappel", title: "Créer un rappel", description: "Créer un rappel de suivi pour traiter l'email" } },
  create_task: { en: { short: "Task", title: "Create task", description: "Create a task to follow up" }, fr: { short: "Tâche", title: "Créer une tâche", description: "Créer une tâche de suivi" } },
  move_to_folder: { en: { short: "Move", title: "Move to folder", description: "Move email to {folder}" }, fr: { short: "Déplacer", title: "Déplacer vers un dossier", description: "Déplacer l'email vers {folder}" } },
  archive: { en: { short: "Archive", title: "Archive", description: "Archive the email" }, fr: { short: "Archiver", title: "Archiver", description: "Archiver l'email" } },
  flag: { en: { short: "Flag", title: "Flag email", description: "Flag the email for follow-up" }, fr: { short: "Marquer", title: "Marquer l'email", description: "Marquer l'email pour suivi" } },
  apply_label: { en: { short: "Label", title: "Apply label", description: "Apply label '{label}'" }, fr: { short: "Étiqueter", title: "Appliquer une étiquette", description: "Appliquer l'étiquette « {label} »" } },
};

function buildSteps(types: StepType[], params: Record<string, unknown>[], trigger: AutomationTrigger["conditions"], lang: Language): AutomationStep[] {
  const steps: AutomationStep[] = [];
  let order = 1;
  const fromText = trigger.fromDomain ? (lang === "fr" ? ` de ${trigger.fromDomain}` : ` from ${trigger.fromDomain}`) : "";
  if (trigger.hasAttachments) {
    const t = STEP_TEXT.detect_attachment!;
    steps.push({ order: order++, type: "detect_attachment", title: t[lang].title, description: t[lang].description.replace("{from}", fromText), parameters: {} });
  }
  types.forEach((type, i) => {
    const p = params[i] ?? {};
    const t = STEP_TEXT[type] ?? { en: { short: type, title: type, description: type }, fr: { short: type, title: type, description: type } };
    const folder = String(p.folder ?? p.destinationFolder ?? p.path ?? (lang === "fr" ? "le dossier habituel" : "the usual folder"));
    const category = String(p.category ?? (p.categories as string[] | undefined)?.[0] ?? (lang === "fr" ? "catégorie habituelle" : "usual category"));
    const label = String(p.label ?? "Internal");
    steps.push({
      order: order++,
      type,
      title: t[lang].title,
      description: t[lang].description.replace("{folder}", folder).replace("{category}", category).replace("{label}", label).replace("{from}", fromText),
      parameters: p,
    });
  });
  return steps;
}

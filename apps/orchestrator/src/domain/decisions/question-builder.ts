import type { Language } from "@oao/shared";
import type { DecisionChoiceQuestion } from "../../ports/decision.js";
import { MAX_DECISION_OPTIONS } from "./schemas.js";
import { localize, type Taxonomy, type TaxonomyArea } from "./taxonomy.js";

/**
 * Questions sent to the decision engine — built **only** from server-side
 * constants and the operator's taxonomy. None of these functions receives the
 * email: its text can never reach an instruction, a criterion or an option id.
 *
 * v1 uses `choice` questions only, binary decisions included
 * (`required` / `not_required`): upstream notes that the current checkpoints
 * may follow boolean-looking labels (`true`/`false`, `yes`/`no`) instead of
 * their descriptions, so option ids are semantic and every option carries a
 * description. Texts are short on purpose: the engine fits the instructions
 * and every option into a ~192–256-token budget.
 *
 * Question ids are stable (`urgency`, `businessArea`, `replyExpected`,
 * `actionRequired`, `folder`): they are the join key of the response mapper,
 * the metrics and the audit.
 */
export const QUESTION_IDS = {
  urgency: "urgency",
  businessArea: "businessArea",
  replyExpected: "replyExpected",
  actionRequired: "actionRequired",
  folder: "folder",
} as const;
export type QuestionId = (typeof QUESTION_IDS)[keyof typeof QUESTION_IDS];

/** Primary (first-request) question ids, in a stable order. */
export const PRIMARY_QUESTION_IDS = [QUESTION_IDS.urgency, QUESTION_IDS.businessArea, QUESTION_IDS.replyExpected, QUESTION_IDS.actionRequired] as const;

export const URGENCY_LEVELS = ["low", "normal", "high", "critical"] as const;
export type UrgencyOption = (typeof URGENCY_LEVELS)[number];

/** Binary decisions use two semantic options (never true/false). */
export const REQUIRED = "required";
export const NOT_REQUIRED = "not_required";

/**
 * Option order. `declared` in production; the evaluation harness permutes the
 * order to measure how stable the answers are (position bias).
 */
export type OptionOrder = "declared" | "reversed" | "rotated";

export interface QuestionBuildOptions {
  order?: OptionOrder;
}

type Localized = { fr: string; en: string };

const TEXT = {
  urgency: {
    instructions: { fr: "Détermine le niveau d'urgence métier du message.", en: "Determine the business urgency of the message." },
    criteria: {
      low: { fr: "Message informatif sans action ni échéance identifiable.", en: "Informational message with no action and no identifiable deadline." },
      normal: { fr: "Action attendue sans blocage ni échéance proche.", en: "An action is expected, with no blocker and no close deadline." },
      high: { fr: "Échéance proche, attente active ou impact métier important.", en: "Close deadline, someone actively waiting, or significant business impact." },
      critical: { fr: "Incident de production, blocage majeur, sécurité, conformité ou échéance immédiate.", en: "Production incident, major blocker, security, compliance or immediate deadline." },
    } satisfies Record<UrgencyOption, Localized>,
  },
  businessArea: {
    instructions: { fr: "Détermine le domaine métier concerné par le message.", en: "Determine the business area the message is about." },
  },
  replyExpected: {
    instructions: { fr: "Détermine si l'expéditeur attend une réponse ou une action.", en: "Determine whether the sender expects a reply or an action." },
    criteria: {
      [REQUIRED]: { fr: "Une réponse, validation, confirmation ou action est explicitement ou implicitement attendue.", en: "A reply, approval, confirmation or action is explicitly or implicitly expected." },
      [NOT_REQUIRED]: { fr: "Le message est uniquement informatif et aucune réponse ou action n'est attendue.", en: "The message is informational only and no reply or action is expected." },
    },
  },
  actionRequired: {
    instructions: { fr: "Détermine si le message demande au destinataire d'agir.", en: "Determine whether the message asks the recipient to act." },
    criteria: {
      [REQUIRED]: { fr: "Le destinataire doit traiter, corriger, fournir, valider ou planifier quelque chose.", en: "The recipient must handle, fix, provide, approve or schedule something." },
      [NOT_REQUIRED]: { fr: "Aucune action n'est demandée au destinataire : information seulement.", en: "No action is asked of the recipient: information only." },
    },
  },
  folder: {
    instructions: { fr: "Détermine le dossier le plus adapté pour classer le message dans le domaine « %s ».", en: 'Determine the most suitable folder to file the message in, within the "%s" area.' },
  },
} as const;

function reorder<T>(entries: Array<[string, T]>, order: OptionOrder = "declared"): Array<[string, T]> {
  if (order === "reversed") return [...entries].reverse();
  if (order === "rotated" && entries.length > 1) return [...entries.slice(1), entries[0]!];
  return entries;
}

function choice(instructions: string, entries: Array<[string, string]>, order?: OptionOrder): DecisionChoiceQuestion {
  if (entries.length > MAX_DECISION_OPTIONS) throw new RangeError(`a question accepts at most ${MAX_DECISION_OPTIONS} options (got ${entries.length})`);
  return { type: "choice", instructions, criteria: Object.fromEntries(reorder(entries, order)) };
}

const localizedEntries = (criteria: Record<string, Localized>, lang: Language): Array<[string, string]> => Object.entries(criteria).map(([id, text]) => [id, localize(text, lang)]);

/** First request: urgency, business area, reply expected, action required. */
export function buildPrimaryQuestions(taxonomy: Taxonomy, lang: Language, opts: QuestionBuildOptions = {}): Record<string, DecisionChoiceQuestion> {
  return {
    [QUESTION_IDS.urgency]: choice(localize(TEXT.urgency.instructions, lang), localizedEntries(TEXT.urgency.criteria, lang), opts.order),
    [QUESTION_IDS.businessArea]: choice(
      localize(TEXT.businessArea.instructions, lang),
      taxonomy.areas.map((a) => [a.id, `${localize(a.labels, lang)} — ${localize(a.descriptions, lang)}`]),
      opts.order,
    ),
    [QUESTION_IDS.replyExpected]: choice(localize(TEXT.replyExpected.instructions, lang), localizedEntries(TEXT.replyExpected.criteria, lang), opts.order),
    [QUESTION_IDS.actionRequired]: choice(localize(TEXT.actionRequired.instructions, lang), localizedEntries(TEXT.actionRequired.criteria, lang), opts.order),
  };
}

/**
 * Second request: the folder, among the folders of one area only. Callers ask
 * it only for an area with at least two folders (one folder is picked
 * deterministically, none means no move).
 */
export function buildFolderQuestion(area: TaxonomyArea, lang: Language, opts: QuestionBuildOptions = {}): Record<string, DecisionChoiceQuestion> {
  if (area.folders.length < 2) throw new RangeError(`area "${area.id}" has ${area.folders.length} folder(s): no folder question is needed`);
  return {
    [QUESTION_IDS.folder]: choice(
      localize(TEXT.folder.instructions, lang).replace("%s", localize(area.labels, lang)),
      area.folders.map((f) => [f.id, `${f.displayName} — ${localize(f.descriptions, lang)}`]),
      opts.order,
    ),
  };
}

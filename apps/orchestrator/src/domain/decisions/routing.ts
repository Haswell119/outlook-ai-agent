import type { Language } from "@oao/shared";
import { EN_STOPWORDS, FR_STOPWORDS } from "../language.js";

/**
 * Which checkpoint answers, and in which language the questions are written.
 *
 * Laya ships an English checkpoint (ModernBERT, 512 tokens) and a
 * multilingual one (mmBERT, 1024 tokens). Upstream measured that the English
 * checkpoint does not degrade gracefully off English: it *collapses* while
 * staying confident. Routing therefore errs on the side of `multilingual`:
 * a text is "English" only on clear evidence, anything doubtful is `unknown`
 * and goes to the multilingual checkpoint.
 */
export type EmailLanguage = "fr" | "en" | "unknown";
export type ModelStrategy = "language" | "auto" | "fixed";

export const ENGLISH_CHECKPOINT = "english";
export const MULTILINGUAL_CHECKPOINT = "multilingual";

/** Names laya-serve maps to its multilingual checkpoint (aliases and published id included). */
const MULTILINGUAL_NAMES = new Set(["multilingual", "multi", "ml", "laya-multilingual", "convaiinnovations/laya-multilingual"]);

/** Letters of neither French nor English: German, Spanish, Nordic, Slavic… text goes to `unknown`. */
const FOREIGN_LETTERS = /[äöüßñåøæãõąćęłńśźżčřšžőű]/gi;
const FRENCH_ACCENTS = /[éèêàçùâîôûëïœ]/gi;

/** FR / EN / unknown from stop words and diacritics. Pure. */
export function detectEmailLanguage(text: string): EmailLanguage {
  const words = text.toLowerCase().match(/[\p{L}'-]+/gu) ?? [];
  if (words.length < 3) return "unknown";
  let fr = 0;
  let en = 0;
  for (const w of words) {
    if (FR_STOPWORDS.has(w)) fr++;
    if (EN_STOPWORDS.has(w)) en++;
  }
  const accents = (text.match(FRENCH_ACCENTS) ?? []).length;
  const foreign = (text.match(FOREIGN_LETTERS) ?? []).length;
  if (foreign >= 3 && foreign > accents) return "unknown";
  fr += Math.min(accents, 5) * 0.5;
  // English needs clear evidence: sending French to the English checkpoint is the costly mistake.
  if (en >= 2 && en >= 2 * fr) return "en";
  if (fr >= 1 && fr > en) return "fr";
  return "unknown";
}

/**
 * Checkpoint for a request. `undefined` = send no `model` field and let
 * laya-serve route by itself (`auto`).
 *  - `language`: English mail → `english`; French or unknown → `multilingual`;
 *  - `auto`: no model field;
 *  - `fixed`: always `fixedModel` (validated at startup).
 */
export function selectModel(strategy: ModelStrategy, lang: EmailLanguage, fixedModel?: string): string | undefined {
  if (strategy === "fixed") return fixedModel;
  if (strategy === "auto") return undefined;
  return lang === "en" ? ENGLISH_CHECKPOINT : MULTILINGUAL_CHECKPOINT;
}

export const isMultilingualCheckpoint = (model: string | undefined): boolean => model !== undefined && MULTILINGUAL_NAMES.has(model.trim().toLowerCase());

/**
 * Language of the questions. Only the multilingual checkpoint reads French
 * instructions; every other checkpoint (english, typed-decisions — both
 * ModernBERT, English only) gets English. For the multilingual checkpoint the
 * questions follow the email, and the reader's language breaks a tie. With
 * `auto` the server may still pick the English checkpoint, so an undecided
 * language stays English there.
 */
export function questionLanguage(model: string | undefined, lang: EmailLanguage, readerLanguage: Language): Language {
  if (model !== undefined && !isMultilingualCheckpoint(model)) return "en";
  if (lang !== "unknown") return lang;
  return model === undefined ? "en" : readerLanguage;
}

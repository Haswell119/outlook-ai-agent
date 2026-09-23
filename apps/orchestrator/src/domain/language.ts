import type { Language } from "@oao/shared";

/**
 * Simple FR/EN language detection based on stop-word ratio.
 * Pure function — no I/O. Returns `fallback` when the text is too short.
 */
/** French stop words (also used by the decision engine's language routing). */
export const FR_STOPWORDS: ReadonlySet<string> = new Set([
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "est", "pour", "que", "qui", "dans", "avec", "vous", "nous",
  "pas", "sur", "ce", "cette", "ces", "au", "aux", "en", "je", "il", "elle", "sont", "être", "avoir", "merci", "bonjour",
  "cordialement", "votre", "vos", "notre", "nos", "mais", "ou", "où", "donc", "si", "plus", "très", "bien", "tout",
  "pièce", "jointe", "ci-joint", "veuillez", "afin", "dès", "lors", "chez", "sans", "sous", "leur", "leurs", "été",
]);
/** English stop words. */
export const EN_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "is", "are", "for", "that", "which", "in", "with", "you", "we", "not", "on", "this", "these",
  "to", "of", "it", "he", "she", "they", "be", "have", "has", "thanks", "hello", "hi", "regards", "your", "our", "but",
  "or", "so", "if", "more", "very", "well", "all", "attached", "please", "would", "could", "should", "will", "can",
  "from", "by", "at", "as", "was", "were", "been", "kind", "best", "dear",
]);

export function detectLanguage(text: string, fallback: Language = "en"): Language {
  const words = text.toLowerCase().match(/[\p{L}'-]+/gu) ?? [];
  if (words.length < 3) return fallback;
  let fr = 0;
  let en = 0;
  for (const w of words) {
    if (FR_STOPWORDS.has(w)) fr++;
    if (EN_STOPWORDS.has(w)) en++;
  }
  // Accented characters are a strong French signal.
  const accents = (text.match(/[éèêàçùâîôû]/g) ?? []).length;
  fr += Math.min(accents, 5) * 0.5;
  if (fr === 0 && en === 0) return fallback;
  if (fr === en) return fallback;
  return fr > en ? "fr" : "en";
}

/** Parse an `Accept-Language` header into fr | en (first supported tag wins). */
export function languageFromAcceptHeader(header: string | undefined, fallback: Language): Language {
  if (!header) return fallback;
  const tags = header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: (tag ?? "").toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    if (tag.startsWith("fr")) return "fr";
    if (tag.startsWith("en")) return "en";
  }
  return fallback;
}

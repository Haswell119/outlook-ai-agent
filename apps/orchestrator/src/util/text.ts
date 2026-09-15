/** Small pure text helpers shared by domain and services. */

export function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Tokenise into lower-case words (letters/digits, accents kept). */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) as string[];
}

/** FR/EN stop-words ignored in search queries. */
export const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "from", "is", "are", "was", "were", "be", "been",
  "this", "that", "these", "those", "it", "its", "as", "if", "then", "than", "so", "do", "does", "did", "has", "have", "had",
  "find", "show", "me", "my", "our", "your", "their", "where", "when", "which", "what", "who", "how", "email", "emails", "mail", "mails", "message", "messages",
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "en", "au", "aux", "ce", "cet", "cette", "ces", "que", "qui", "quoi", "dans", "sur", "pour",
  "par", "avec", "sans", "est", "sont", "été", "être", "avoir", "il", "elle", "ils", "elles", "nous", "vous", "je", "tu", "on", "mon", "ma", "mes", "ton", "ta",
  "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos", "leur", "leurs", "où", "quand", "comment", "trouve", "trouver", "cherche", "chercher", "quel", "quelle", "quels", "quelles",
]);

/** Meaningful search terms of a query (lower-case, ≥ 2 chars, stop-words removed, deduplicated). */
export function queryTerms(query: string): string[] {
  const terms = Array.from(new Set(tokenize(query))).filter((t) => !STOPWORDS.has(t));
  // Keep something to search for when the query is only stop-words.
  return terms.length ? terms : Array.from(new Set(tokenize(query)));
}

/**
 * Postgres `to_tsquery('simple', …)` expression: terms OR-ed with prefix matching
 * (approv:* matches approved / approval), so ranking (ts_rank) rewards documents
 * that contain more of the terms instead of requiring all of them.
 */
export function toTsQuery(query: string): string {
  const safe = queryTerms(query).map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter((t) => t.length >= 2);
  return safe.map((t) => (t.length >= 5 ? `${t.slice(0, Math.max(4, t.length - 2))}:*` : t)).join(" | ");
}

/** Split text into ~maxChars chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, maxChars = 1200, overlap = 100): string[] {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const sentences = clean.split(/(?<=[.!?\n])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + " " + sentence).length > maxChars && current) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap)) + " " + sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  // Hard fallback: a "sentence" longer than maxChars (no punctuation) is split on words.
  return chunks.flatMap((c) => {
    if (c.length <= maxChars) return [c];
    const out: string[] = [];
    let buf = "";
    for (const word of c.split(" ")) {
      if ((buf + " " + word).length > maxChars && buf) {
        out.push(buf);
        buf = word;
      } else buf = buf ? `${buf} ${word}` : word;
    }
    if (buf) out.push(buf);
    return out;
  });
}

/**
 * Best matching window of `text` for `query`: the ±`radius` chars around the
 * densest cluster of query terms. Falls back to the beginning of the text.
 */
export function bestExcerpt(text: string, query: string, radius = 200): string {
  const clean = normalizeWhitespace(text);
  if (!clean) return "";
  const terms = Array.from(new Set(tokenize(query))).filter((t) => t.length >= 3);
  const lower = clean.toLowerCase();
  let bestPos = -1;
  let bestScore = 0;
  for (const term of terms) {
    let idx = lower.indexOf(term);
    while (idx >= 0) {
      const windowStart = Math.max(0, idx - radius);
      const windowEnd = Math.min(lower.length, idx + radius);
      const window = lower.slice(windowStart, windowEnd);
      const score = terms.reduce((acc, t) => acc + (window.includes(t) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestPos = idx;
      }
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  if (bestPos < 0) return truncate(clean, radius * 2);
  const start = Math.max(0, bestPos - radius);
  const end = Math.min(clean.length, bestPos + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

/** Simple Levenshtein distance (used for lookalike domains). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/** Compile a policy regex; supports the `(?i)` inline flag prefix used in DEFAULT_POLICY. */
export function compilePattern(pattern: string, extraFlags = ""): RegExp | undefined {
  let source = pattern;
  let flags = extraFlags;
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    for (const f of inline[1] ?? "") if (["i", "m", "s", "u"].includes(f) && !flags.includes(f)) flags += f;
  }
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

/** Extract ISO-like or textual dates (FR/EN) from text. */
export function extractDates(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g,
    /\b\d{1,2}(?:st|nd|rd|th|er)?\s+(?:janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/gi,
    /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
  ];
  for (const p of patterns) for (const m of text.match(p) ?? []) found.add(m.trim());
  return Array.from(found);
}

export function extractUrls(text: string): string[] {
  return text.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) ?? [];
}

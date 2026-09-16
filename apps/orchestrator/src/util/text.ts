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

/** Longest policy pattern we will compile. Anything longer is a mistake, not a rule. */
export const MAX_PATTERN_LENGTH = 512;

/**
 * Static catastrophic-backtracking screen for operator-supplied regexes.
 *
 * `Policy.sensitiveDataPatterns` is edited in the admin dashboard and then run
 * by `findSensitiveData` against every outgoing mail body. Node's RegExp engine
 * is backtracking and has **no timeout**, so a single `(a+)+$` typed into the
 * Policy Center would pin the event loop of every orchestrator replica on the
 * next compliance check — a full outage from one text field.
 *
 * There is no cheap exact test for exponential blow-up, so this rejects the two
 * shapes that cause it in practice, both of which are a *quantified group*:
 *  - whose body is itself quantified — `(a+)+`, `(a*)*`, `(?:x+){2,}`;
 *  - whose body is an alternation, whose branches can then overlap —
 *    `(a|aa)+`, `(\d|\d\d)*`.
 *
 * This is deliberately conservative and can reject a safe pattern; the
 * alternative is an operator able to take the service down from a text field.
 * Linear patterns — which is what IBAN / account-number / AVS rules are, see
 * `DEFAULT_POLICY` — are unaffected, and that is pinned by a test.
 */
export function isPotentiallyCatastrophic(source: string): boolean {
  // Walk the pattern, tracking group spans, and look for `(...)` followed by a
  // quantifier where the group body also contains an unbounded quantifier.
  const starts: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++; // escaped char: never a group delimiter
      continue;
    }
    if (ch === "[") {
      // Character class: quantifiers inside are literal, skip to the end.
      while (i < source.length && source[i] !== "]") {
        if (source[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") {
      starts.push(i);
      continue;
    }
    if (ch === ")") {
      const start = starts.pop();
      if (start === undefined) continue;
      const next = source[i + 1];
      const quantified = next === "+" || next === "*" || next === "{";
      if (!quantified) continue;
      const body = source.slice(start + 1, i);
      // `+`/`*`/`{n,}` inside the repeated group ⇒ two nested unbounded loops.
      if (/(?<!\\)[+*]/.test(body) || /(?<!\\)\{\d+,\}/.test(body)) return true;
      // A repeated alternation whose branches can match the same text — the
      // `(a|aa)+` family — backtracks exponentially just as badly.
      if (hasTopLevelAlternation(body)) return true;
    }
  }
  return false;
}

/** True when `body` contains a `|` that is not inside a nested group or class. */
function hasTopLevelAlternation(body: string): boolean {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < body.length && body[i] !== "]") {
        if (body[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) return true;
  }
  return false;
}

export interface PatternProblem {
  reason: "too_long" | "invalid_syntax" | "catastrophic_backtracking";
  detail: string;
}

/**
 * Validate a policy pattern without compiling it into the hot path.
 * Returns `undefined` when the pattern is safe to use.
 */
export function checkPattern(pattern: string): PatternProblem | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) return { reason: "too_long", detail: `pattern is ${pattern.length} characters (max ${MAX_PATTERN_LENGTH})` };
  const { source, flags } = splitInlineFlags(pattern, "");
  if (isPotentiallyCatastrophic(source)) return { reason: "catastrophic_backtracking", detail: "nested quantifiers can make matching exponential (e.g. `(a+)+`)" };
  try {
    new RegExp(source, flags);
  } catch (e) {
    return { reason: "invalid_syntax", detail: (e as Error).message };
  }
  return undefined;
}

/** Split a leading `(?i)`-style inline flag group off a pattern. */
function splitInlineFlags(pattern: string, extraFlags: string): { source: string; flags: string } {
  let source = pattern;
  let flags = extraFlags;
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline) {
    source = source.slice(inline[0].length);
    for (const f of inline[1] ?? "") if (["i", "m", "s", "u"].includes(f) && !flags.includes(f)) flags += f;
  }
  return { source, flags };
}

/**
 * Compile a policy regex; supports the `(?i)` inline flag prefix used in
 * DEFAULT_POLICY. Returns `undefined` for a pattern that is invalid **or**
 * rejected by `checkPattern` — the caller skips the rule rather than hanging.
 */
export function compilePattern(pattern: string, extraFlags = ""): RegExp | undefined {
  if (checkPattern(pattern)) return undefined;
  const { source, flags } = splitInlineFlags(pattern, extraFlags);
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

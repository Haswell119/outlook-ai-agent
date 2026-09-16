/**
 * Robust JSON extraction from LLM output:
 *  1. strip <think>…</think> reasoning blocks (Qwen3 & co, closed or unclosed),
 *  2. strip markdown code fences,
 *  3. parse the whole text, else the first balanced {...} object.
 */
export function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Unclosed <think> at the beginning: keep what follows the last </think> or drop the block.
  const open = out.search(/<think>/i);
  if (open >= 0) {
    const close = out.search(/<\/think>/i);
    out = close >= 0 ? out.slice(close + 8) : out.slice(0, open) + out.slice(open).replace(/<think>[\s\S]*$/i, "");
  }
  return out.trim();
}

export function stripCodeFences(text: string): string {
  const fenced = /```(?:json|JSON|javascript|js)?\s*([\s\S]*?)```/.exec(text);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  return text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
}

/** First balanced top-level `{…}` (string-aware). */
export function firstBalancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

export function extractJson(raw: string): unknown {
  const cleaned = stripCodeFences(stripThinkBlocks(raw));
  const candidates = [cleaned, firstBalancedObject(cleaned)].filter((c): c is string => typeof c === "string" && c.length > 0);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (e) {
      lastError = e;
      // Common model slip: trailing commas.
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      } catch (e2) {
        lastError = e2;
      }
    }
  }
  throw new Error(`No JSON object found in model output: ${(lastError as Error | undefined)?.message ?? "empty"}`);
}

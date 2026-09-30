import type { IndexedChunk } from "../ports/repositories.js";

/**
 * One key per message, whatever id it was stored under: the Internet Message-ID
 * when known — an imported `.eml` and the same mail opened in Outlook, or one
 * message filed in two folders, are the same message — else the email id.
 */
export const messageKey = (c: Pick<IndexedChunk, "emailId" | "internetMessageId">): string => {
  const mid = c.internetMessageId?.trim();
  return mid ? `mid:${mid}` : `id:${c.emailId}`;
};

/**
 * Keeps one chunk per message, in the original order; among copies, the first
 * one `prefer` accepts wins (e.g. the copy that has a precomputed analysis).
 */
export function onePerMessage<T extends Pick<IndexedChunk, "emailId" | "internetMessageId">>(chunks: T[], prefer: (c: T) => boolean = () => false): T[] {
  const kept = new Map<string, T>();
  for (const c of chunks) {
    const key = messageKey(c);
    const prev = kept.get(key);
    if (!prev || (!prefer(prev) && prefer(c))) kept.set(key, c);
  }
  return [...kept.values()];
}

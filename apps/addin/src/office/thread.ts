import type { EmailContext, ThreadContext } from "@oao/shared";
import { isOfficeAvailable } from "./env";
import { loadConversationFromCache } from "./cache";
import { sampleThread } from "./sample";

/**
 * Build a ThreadContext for the conversation of `current`.
 * Office.js only exposes the opened item, so the thread contains the current
 * message plus any item of the same conversation the user opened earlier in
 * this session (local cache). The orchestrator expands the conversation via
 * Microsoft Graph when GRAPH_ENABLED=true.
 */
export async function readThread(current: EmailContext): Promise<ThreadContext> {
  if (!isOfficeAvailable()) return sampleThread;
  const conversationId = current.conversationId ?? current.id;
  const cached = loadConversationFromCache(conversationId).filter((m) => m.id !== current.id);
  const messages = [...cached, current];
  return { conversationId, subject: current.subject, messages };
}

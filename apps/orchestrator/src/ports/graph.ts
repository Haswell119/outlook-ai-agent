import type { EmailContext } from "@oao/shared";

/** Minimal Microsoft Graph surface used by the orchestrator (OBO on the user's token). */
export interface GraphClient {
  readonly enabled: boolean;
  getMessage(userToken: string, messageId: string): Promise<EmailContext>;
  getConversationMessages(userToken: string, conversationId: string): Promise<EmailContext[]>;
  listRecentMessages(userToken: string, n: number): Promise<EmailContext[]>;
  createTodoTask(userToken: string, task: { title: string; dueDateTime?: string; body?: string }): Promise<{ id: string }>;
  createCalendarEvent(userToken: string, event: { subject: string; start: string; end: string; body?: string }): Promise<{ id: string }>;
  moveMessage(userToken: string, messageId: string, destinationFolder: string): Promise<{ id: string }>;
  updateCategories(userToken: string, messageId: string, categories: string[]): Promise<void>;
  flagMessage(userToken: string, messageId: string, flagged: boolean): Promise<void>;
}

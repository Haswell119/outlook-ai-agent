import type { EmailContext } from "@oao/shared";

/**
 * How the orchestrator reaches one mailbox.
 *
 *  - `obo`  : delegated — the add-in's Office SSO token is exchanged
 *             On-Behalf-Of for a Graph token for that same user. Interactive
 *             requests always use this.
 *  - `cached`: delegated, refreshed silently from the MSAL token cache using
 *             the `homeAccountId` remembered on a previous SSO call. This is
 *             how the background worker reaches a mailbox without application
 *             permissions (see docs/AI_LOAD.md for the limits).
 *  - `app`  : application permissions (client credentials, `Mail.Read`
 *             restricted by an Exchange application access policy). The
 *             recommended production mode for a 50-mailbox tenant.
 */
export type MailboxAccess =
  | { kind: "obo"; userToken: string }
  | { kind: "cached"; homeAccountId: string; userPrincipalName: string }
  | { kind: "app"; userPrincipalName: string };

/** One page of a `/messages/delta` query. */
export interface GraphDeltaPage {
  messages: EmailContext[];
  /** Opaque token to persist and replay on the next run. */
  deltaToken?: string;
  /** Present when more pages are available right now. */
  hasMore: boolean;
  /** Ids returned as `@removed` (deleted / moved out of the inbox). */
  removedIds: string[];
}

/** Minimal Microsoft Graph surface used by the orchestrator. */
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

  /* ------------------------- precomputation ------------------------- */

  /**
   * Inbox delta query. Pass the token stored on the previous run to get only
   * what changed; pass `undefined` for an initial (bounded) sync.
   */
  deltaInbox(access: MailboxAccess, deltaToken: string | undefined, maxMessages: number): Promise<GraphDeltaPage>;

  /**
   * Remember a user's delegated token in the MSAL cache so the worker can
   * refresh it silently later. Returns the account handle to persist, or
   * `undefined` when the exchange produced no re-usable account.
   */
  rememberDelegatedUser(userToken: string): Promise<{ homeAccountId: string } | undefined>;

  /** True when `access` can still obtain a token (silent refresh still valid). */
  canAccess(access: MailboxAccess): Promise<boolean>;

  /** Members of an AAD group, as UPNs (`SYNC_GROUP_ID`, application mode only). */
  listGroupMemberUpns(groupId: string): Promise<string[]>;
}

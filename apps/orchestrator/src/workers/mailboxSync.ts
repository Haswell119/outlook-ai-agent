import type { EmailAnalysis, EmailContext, MailboxSyncStatus } from "@oao/shared";
import { MailboxSyncStatusSchema } from "@oao/shared";
import { triageEmail } from "../domain/triage.js";
import { AppError } from "../errors.js";
import type { Metrics } from "../metrics.js";
import type { MailboxAccess } from "../ports/graph.js";
import type { MailboxSyncState } from "../ports/repositories.js";
import type { AnalyzeEmailService } from "../services/AnalyzeEmailService.js";
import type { AuditService } from "../services/AuditService.js";
import type { RequestContext, ServiceDeps } from "../services/context.js";
import type { IndexEmailsService } from "../services/IndexEmailsService.js";
import type { PolicyService } from "../services/PolicyService.js";
import { nowIso } from "../util/ids.js";

/**
 * Mailbox precomputation worker — the reason `GET /analyze/email/:id` is instant.
 *
 * Every `SYNC_INTERVAL_MINUTES` the worker pulls what changed in each synced
 * inbox with a Graph **delta query**, indexes it (embeddings, cached), triages
 * it, and analyses the `conversation` emails **at background priority**. By the
 * time the user opens Outlook the answer is already in `analysis_cache` and is
 * served as `source: "precomputed"` with no GPU work on the critical path.
 *
 * Two access modes:
 *
 *  - **Delegated (`GRAPH_AUTH_MODE=obo`, implemented first).** When a user calls
 *    any endpoint with an AAD token and `PRECOMPUTE_ENABLED=true`, the token is
 *    exchanged On-Behalf-Of and the resulting account is kept in the msal-node
 *    token cache; its `homeAccountId` is persisted in `mailbox_sync_state`, and
 *    the worker later refreshes silently (`acquireTokenSilent`).
 *    *Limits, by design of OBO:* the cache is **in-process and not persisted**,
 *    so a pod restart loses it until the user calls again; the underlying
 *    refresh token is revocable and expires (a user who does not open Outlook
 *    for weeks stops being synced); and Conditional Access policies can refuse
 *    a silent refresh. The worker treats all of these as "not syncable right
 *    now": the mailbox goes to `state: "error"` with an explanatory
 *    `lastError`, and resumes by itself on the user's next request.
 *
 *  - **Application (`GRAPH_AUTH_MODE=app`, recommended for 50 users).** Client
 *    credentials with the `Mail.Read` **application** permission, scoped to the
 *    project's mailboxes by an Exchange *application access policy*:
 *      New-ApplicationAccessPolicy -AppId <clientId> `
 *        -PolicyScopeGroupId oao-synced@northbridge.example `
 *        -AccessRight RestrictAccess -Description "Outlook AI Orchestrator"
 *    The worker then syncs `SYNC_USERS`, or the members of `SYNC_GROUP_ID`, with
 *    no dependency on anyone being logged in.
 */
export interface SyncResult {
  userId: string;
  fetched: number;
  indexed: number;
  analysed: number;
  skippedByTriage: number;
  removed: number;
  hasMore: boolean;
  error?: string;
}

export class MailboxSyncService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly indexer: IndexEmailsService,
    private readonly analyzer: AnalyzeEmailService,
    private readonly policy: PolicyService,
    private readonly metrics?: Metrics,
  ) {}

  private get cfg() {
    return this.deps.cfg;
  }

  get enabled(): boolean {
    return this.cfg.GRAPH_ENABLED && this.cfg.PRECOMPUTE_ENABLED;
  }

  /* ----------------------------- registration --------------------------- */

  /**
   * Called opportunistically on authenticated requests: remembers that this
   * user's mailbox can be synced with their delegated token.
   * Never throws — a registration failure must not break the request.
   */
  async register(ctx: RequestContext): Promise<void> {
    if (!this.enabled || this.cfg.GRAPH_AUTH_MODE !== "obo") return;
    const token = ctx.user.token;
    if (!token || ctx.user.via !== "aad-jwt") return;
    try {
      const existing = await this.deps.repos.mailboxSync.get(ctx.user.id);
      // Re-registering on every request would hammer AAD; refresh at most hourly.
      if (existing?.msalHomeAccountId && existing.updatedAt > new Date(Date.now() - 3_600_000).toISOString()) return;
      const remembered = await this.deps.graph.rememberDelegatedUser(token);
      if (!remembered) return;
      await this.deps.repos.mailboxSync.put({
        userId: ctx.user.id,
        userEmail: ctx.user.email,
        deltaToken: existing?.deltaToken,
        state: existing?.state === "disabled" ? "disabled" : "idle",
        lastSyncAt: existing?.lastSyncAt,
        nextSyncAt: existing?.nextSyncAt,
        lastError: undefined,
        indexedEmails: existing?.indexedEmails ?? 0,
        precomputedAnalyses: existing?.precomputedAnalyses ?? 0,
        pending: existing?.pending ?? 0,
        authMode: "obo",
        msalHomeAccountId: remembered.homeAccountId,
        updatedAt: nowIso(),
      });
      this.deps.logger.debug({ user: ctx.user.email }, "mailbox registered for background sync");
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message }, "mailbox sync registration failed");
    }
  }

  /** In application mode, make sure every configured mailbox has a state row. */
  async seedApplicationUsers(): Promise<number> {
    if (!this.enabled || this.cfg.GRAPH_AUTH_MODE !== "app") return 0;
    let upns = [...this.cfg.SYNC_USERS];
    if (this.cfg.SYNC_GROUP_ID) {
      try {
        upns = Array.from(new Set([...upns, ...(await this.deps.graph.listGroupMemberUpns(this.cfg.SYNC_GROUP_ID))]));
      } catch (e) {
        this.deps.logger.warn({ err: (e as Error).message, group: this.cfg.SYNC_GROUP_ID }, "could not expand SYNC_GROUP_ID");
      }
    }
    let created = 0;
    for (const upn of upns) {
      const userId = upn.toLowerCase();
      if (await this.deps.repos.mailboxSync.get(userId)) continue;
      await this.deps.repos.mailboxSync.put({ userId, userEmail: userId, state: "idle", indexedEmails: 0, precomputedAnalyses: 0, pending: 0, authMode: "app", updatedAt: nowIso() });
      created++;
    }
    return created;
  }

  /* -------------------------------- status ------------------------------ */

  async status(userId: string): Promise<MailboxSyncStatus> {
    const state = await this.deps.repos.mailboxSync.get(userId);
    const indexedEmails = await this.deps.repos.emailIndex.count(userId).catch(() => 0);
    const precomputedAnalyses = await this.deps.repos.analysisCache.countPrecomputed(userId).catch(() => 0);
    if (!this.enabled) {
      return MailboxSyncStatusSchema.parse({
        enabled: false,
        state: "disabled",
        indexedEmails,
        precomputedAnalyses,
        pending: 0,
        lastError: this.cfg.GRAPH_ENABLED ? "PRECOMPUTE_ENABLED=false" : "GRAPH_ENABLED=false",
      });
    }
    return MailboxSyncStatusSchema.parse({
      enabled: true,
      state: state?.state ?? "idle",
      lastSyncAt: state?.lastSyncAt,
      nextSyncAt: state?.nextSyncAt,
      indexedEmails,
      precomputedAnalyses,
      pending: state?.pending ?? 0,
      lastError: state?.lastError,
    });
  }

  /* --------------------------------- sync ------------------------------- */

  /** Access descriptor for a stored mailbox state. */
  private accessFor(state: MailboxSyncState): MailboxAccess | undefined {
    if (state.authMode === "app") return { kind: "app", userPrincipalName: state.userEmail };
    if (state.msalHomeAccountId) return { kind: "cached", homeAccountId: state.msalHomeAccountId, userPrincipalName: state.userEmail };
    return undefined;
  }

  /** Sync one mailbox. Called by the scheduler and by `POST /mailbox/sync`. */
  async syncUser(userId: string, opts: { userToken?: string; userEmail?: string; priority?: "interactive" | "background" } = {}): Promise<SyncResult> {
    if (!this.enabled) throw AppError.graphUnavailable("Mailbox precomputation is disabled (needs GRAPH_ENABLED=true and PRECOMPUTE_ENABLED=true)");

    let state = await this.deps.repos.mailboxSync.get(userId);
    if (!state) {
      if (!opts.userEmail) throw AppError.notFound("Mailbox sync state");
      state = { userId, userEmail: opts.userEmail, state: "idle", indexedEmails: 0, precomputedAnalyses: 0, pending: 0, authMode: this.cfg.GRAPH_AUTH_MODE, updatedAt: nowIso() };
    }
    if (state.state === "disabled") throw AppError.conflict("Mailbox sync is disabled for this user");

    // A stale `syncing` (crashed pod) is reclaimed after 3 intervals.
    const staleAfter = Date.now() - this.cfg.SYNC_INTERVAL_MINUTES * 3 * 60_000;
    if (state.state === "syncing" && Date.parse(state.updatedAt) > staleAfter) {
      return { userId, fetched: 0, indexed: 0, analysed: 0, skippedByTriage: 0, removed: 0, hasMore: true, error: "already syncing" };
    }

    const access: MailboxAccess | undefined = opts.userToken ? { kind: "obo", userToken: opts.userToken } : this.accessFor(state);
    if (!access) {
      const error = state.authMode === "obo" ? "no cached delegated token — the user must call the API again from Outlook (see docs/AI_LOAD.md)" : "no application access configured for this mailbox";
      await this.save({ ...state, state: "error", lastError: error, nextSyncAt: this.nextRun(), updatedAt: nowIso() });
      this.metrics?.syncRuns.inc({ outcome: "no_access", mode: state.authMode });
      return { userId, fetched: 0, indexed: 0, analysed: 0, skippedByTriage: 0, removed: 0, hasMore: false, error };
    }

    await this.save({ ...state, state: "syncing", updatedAt: nowIso() });
    const started = Date.now();
    const syncUser = { id: userId, email: state.userEmail, displayName: state.userEmail, roles: ["user"] as const, via: "aad-jwt" as const };
    const ctx: RequestContext = { user: { ...syncUser, roles: ["user"] }, language: this.cfg.DEFAULT_LANGUAGE, correlationId: `sync-${userId}-${started}` };

    try {
      const page = await this.deps.graph.deltaInbox(access, state.deltaToken, this.cfg.SYNC_MAX_MESSAGES_PER_RUN);
      this.metrics?.syncMessages.inc({ stage: "fetched" }, page.messages.length);

      /* 1. index (embeddings are cached, so a re-sync is nearly free) */
      let indexed = 0;
      if (page.messages.length) {
        const r = await this.indexer.index(ctx, page.messages, { audit: false });
        indexed = r.indexed;
        this.metrics?.syncMessages.inc({ stage: "indexed" }, indexed);
      }

      /* 2. triage, then analyse only what is worth a model call */
      const policy = await this.policy.get();
      let analysed = 0;
      let skippedByTriage = 0;
      for (const message of page.messages) {
        const triage = this.cfg.TRIAGE_ENABLED ? triageEmail(message, { internalDomains: policy.internalDomains }) : undefined;
        if (triage?.skipModel) {
          skippedByTriage++;
          this.metrics?.syncMessages.inc({ stage: "triaged" });
          continue;
        }
        try {
          const analysis = await this.analyzeInBackground(ctx, message);
          await this.analyzer.storePrecomputed(userId, analysis, message.conversationId);
          analysed++;
          this.metrics?.syncMessages.inc({ stage: "analysed" });
        } catch (e) {
          // One bad message must never stop the run (nor retry forever).
          this.deps.logger.warn({ err: (e as Error).message, emailId: message.id }, "precompute analysis failed");
          this.metrics?.syncMessages.inc({ stage: "failed" });
        }
      }

      const precomputedAnalyses = await this.deps.repos.analysisCache.countPrecomputed(userId).catch(() => state!.precomputedAnalyses);
      const finishedAt = nowIso();
      await this.save({
        ...state,
        deltaToken: page.deltaToken ?? state.deltaToken,
        state: "idle",
        lastSyncAt: finishedAt,
        // More pages waiting → come back immediately instead of waiting a full interval.
        nextSyncAt: page.hasMore ? new Date(Date.now() + 15_000).toISOString() : this.nextRun(),
        lastError: undefined,
        indexedEmails: state.indexedEmails + indexed,
        precomputedAnalyses,
        pending: page.hasMore ? 1 : 0,
        updatedAt: finishedAt,
      });

      await this.audit.record({
        user: { id: userId, email: state.userEmail, displayName: state.userEmail },
        type: "emails_indexed",
        approvalStatus: "auto_approved",
        correlationId: ctx.correlationId,
        latencyMs: Date.now() - started,
        details: { stage: "mailbox_sync", authMode: access.kind, fetched: page.messages.length, indexed, analysed, skippedByTriage, removed: page.removedIds.length, hasMore: page.hasMore },
      });
      this.metrics?.syncRuns.inc({ outcome: "ok", mode: access.kind });
      this.metrics?.syncLag.set({ user: state.userEmail }, 0);
      return { userId, fetched: page.messages.length, indexed, analysed, skippedByTriage, removed: page.removedIds.length, hasMore: page.hasMore };
    } catch (e) {
      const error = (e as Error).message;
      await this.save({ ...state, state: "error", lastError: error.slice(0, 500), nextSyncAt: this.nextRun(), updatedAt: nowIso() });
      await this.audit.record({ user: { id: userId, email: state.userEmail }, type: "error", correlationId: ctx.correlationId, details: { stage: "mailbox_sync", error } });
      this.metrics?.syncRuns.inc({ outcome: "error", mode: access.kind });
      this.deps.logger.warn({ err: error, userId }, "mailbox sync failed");
      return { userId, fetched: 0, indexed: 0, analysed: 0, skippedByTriage: 0, removed: 0, hasMore: false, error };
    }
  }

  /**
   * Full analysis at background priority: the interactive lane always wins, and
   * an open circuit makes this fail fast instead of piling up.
   */
  private async analyzeInBackground(ctx: RequestContext, email: EmailContext): Promise<EmailAnalysis> {
    return this.analyzer.analyze(ctx, { email, includeThread: false, language: ctx.language }, { priority: "background" });
  }

  /** One scheduler tick: sync every mailbox whose `nextSyncAt` is due. */
  async syncDue(limit = 25): Promise<SyncResult[]> {
    if (!this.enabled) return [];
    await this.seedApplicationUsers();
    const due = await this.deps.repos.mailboxSync.listDue(nowIso(), limit);
    const results: SyncResult[] = [];
    for (const state of due) {
      results.push(await this.syncUser(state.userId));
      if (state.lastSyncAt) this.metrics?.syncLag.set({ user: state.userEmail }, Math.max(0, (Date.now() - Date.parse(state.lastSyncAt)) / 1000));
    }
    return results;
  }

  /** Mailboxes the daily-brief job must cover. */
  async syncedUsers(): Promise<Array<{ userId: string; userEmail: string }>> {
    const all = await this.deps.repos.mailboxSync.list();
    return all.filter((s) => s.state !== "disabled").map((s) => ({ userId: s.userId, userEmail: s.userEmail }));
  }

  private nextRun(): string {
    return new Date(Date.now() + this.cfg.SYNC_INTERVAL_MINUTES * 60_000).toISOString();
  }

  private async save(state: MailboxSyncState): Promise<void> {
    await this.deps.repos.mailboxSync.put(state);
  }
}

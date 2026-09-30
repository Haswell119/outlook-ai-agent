import type { EmailContext, MailboxImportFileResult, MailboxImportRequest, MailboxImportResponse } from "@oao/shared";
import { MAILBOX_IMPORT_MAX_BATCH_BYTES, MailboxImportResponseSchema } from "@oao/shared";
import { MailFileError, parseMailFile } from "../adapters/mailfile/parse.js";
import type { AuthenticatedUser } from "../auth/identity.js";
import { triageEmail } from "../domain/triage.js";
import { AppError } from "../errors.js";
import type { Metrics } from "../metrics.js";
import type { AnalyzeEmailService } from "./AnalyzeEmailService.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import type { IndexEmailsService } from "./IndexEmailsService.js";
import type { PolicyService } from "./PolicyService.js";
import type { UsersService } from "./UsersService.js";

/** Identity of the shared admin token (`adminTokenIdentity`): never a mailbox owner. */
const ADMIN_DASHBOARD_ID = "admin-dashboard";

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Mailbox import — `.eml` / `.msg` files uploaded from the admin dashboard and
 * processed like one page of a Graph delta sync (`MailboxSyncService.syncUser`):
 * indexed for search and chat, triaged, and — only when asked — analysed at
 * background priority and kept as precomputed analyses (daily brief, instant
 * answers). It lets a deployment without Graph (`GRAPH_ENABLED=false`) be tried
 * on a real mailbox.
 *
 * Read-only towards the mailbox by construction: the files are parsed in
 * memory, nothing is moved, sent or deleted, and every proposed action still
 * goes through the usual human validation. The message content is untrusted
 * data; it is never logged nor audited (the audit event carries counts only).
 */
export class MailboxImportService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly indexer: IndexEmailsService,
    private readonly analyzer: AnalyzeEmailService,
    private readonly policy: PolicyService,
    private readonly users: UsersService,
    private readonly metrics?: Metrics,
  ) {}

  async import(actor: AuthenticatedUser, req: MailboxImportRequest): Promise<MailboxImportResponse> {
    const started = Date.now();
    const files = req.files.map((f) => ({ name: f.name, folder: f.folder?.trim() || undefined, bytes: new Uint8Array(Buffer.from(f.contentBase64, "base64")) }));
    const total = files.reduce((n, f) => n + f.bytes.length, 0);
    if (total > MAILBOX_IMPORT_MAX_BATCH_BYTES) {
      throw AppError.validation(`Batch too large: ${mb(total)} MB of files, max ${mb(MAILBOX_IMPORT_MAX_BATCH_BYTES)} MB per request — send fewer files at once`);
    }

    const owner = await this.ownerId(req.mailbox);
    const ctx: RequestContext = {
      user: { id: owner.userId, email: req.mailbox, displayName: req.mailbox, roles: ["user"], via: actor.via },
      language: this.deps.cfg.DEFAULT_LANGUAGE,
      correlationId: `import-${req.importId}-${started}`,
    };

    /* 1. parse — one bad file never stops the batch */
    const results: MailboxImportFileResult[] = [];
    const parsed: Array<{ email: EmailContext; result: MailboxImportFileResult }> = [];
    const seen = new Set<string>();
    for (const [index, file] of files.entries()) {
      let email: EmailContext;
      try {
        email = await parseMailFile(file);
      } catch (e) {
        if (e instanceof MailFileError) {
          results.push({ name: file.name, status: "rejected", reason: e.message });
        } else {
          // The parser's own message may quote the file: log its class only.
          this.deps.logger.warn({ importId: req.importId, index, err: (e as Error).name }, "mail file could not be parsed");
          results.push({ name: file.name, status: "failed", reason: "the file could not be read" });
        }
        continue;
      }
      if (!email.subject.trim() && !email.body.trim() && !email.bodyPreview?.trim()) {
        results.push({ name: file.name, status: "rejected", emailId: email.id, reason: "no subject and no text: nothing to index" });
        continue;
      }
      const duplicate = seen.has(email.id) || (await this.deps.repos.emailIndex.hasEmail(owner.userId, email.id));
      seen.add(email.id);
      const result: MailboxImportFileResult = { name: file.name, status: duplicate ? "duplicate" : "imported", emailId: email.id };
      results.push(result);
      parsed.push({ email, result });
    }

    /* 2. index what is new (embeddings are cached, so a re-import is nearly free) */
    const fresh = parsed.filter((p) => p.result.status === "imported").map((p) => p.email);
    const indexed = fresh.length ? await this.indexer.index(ctx, fresh, { audit: false }) : undefined;

    /* 3. optional: triage, then analyse what is worth a model call */
    let analysed = 0;
    let skippedByTriage = 0;
    if (req.analyze && parsed.length) {
      const policy = await this.policy.get();
      for (const { email, result } of parsed) {
        const triage = this.deps.cfg.TRIAGE_ENABLED ? triageEmail(email, { internalDomains: policy.internalDomains }) : undefined;
        if (triage?.skipModel) {
          skippedByTriage++;
          continue;
        }
        try {
          const analysis = await this.analyzer.analyze(ctx, { email, includeThread: false, force: false, language: ctx.language }, { priority: "background" });
          await this.analyzer.storePrecomputed(owner.userId, analysis, email.conversationId);
          result.analysed = true;
          analysed++;
        } catch (e) {
          // The message stays imported: only its precomputed analysis is missing.
          this.deps.logger.warn({ importId: req.importId, emailId: email.id, err: (e as Error).message }, "import analysis failed");
          result.analysed = false;
          result.reason = "imported, but the analysis failed (it will run when the message is opened)";
        }
      }
    }

    const count = (status: MailboxImportFileResult["status"]) => results.filter((r) => r.status === status).length;
    const counts = { files: files.length, imported: count("imported"), duplicate: count("duplicate"), rejected: count("rejected"), failed: count("failed"), analysed, skippedByTriage };
    for (const r of results) this.metrics?.mailboxImportFiles.inc({ outcome: r.status });
    const mode = indexed?.mode ?? (this.indexer.embeddingsAvailable ? "hybrid" : "lexical");
    const warning = [owner.warning, indexed?.warning].filter(Boolean).join(" ") || undefined;

    await this.audit.record({
      user: actor,
      type: "emails_indexed",
      approvalStatus: "auto_approved",
      source: { label: `Import ${req.mailbox}` },
      correlationId: ctx.correlationId,
      latencyMs: Date.now() - started,
      details: { stage: "mailbox_import", importId: req.importId, mailbox: req.mailbox, userId: owner.userId, analyze: req.analyze, mode, ...counts },
    });

    return MailboxImportResponseSchema.parse({ importId: req.importId, mailbox: req.mailbox, userId: owner.userId, mode, warning, counts, results });
  }

  /**
   * The key the mailbox's messages are stored under: the id the add-in
   * presents for that user, so that search, chat and the brief find them —
   * the address itself in `AUTH_MODE=dev`, the Entra object id (taken from the
   * audit trail) in `AUTH_MODE=aad`. A mailbox never seen in `aad` mode falls
   * back to its address, as the Graph application-mode sync does.
   */
  private async ownerId(mailbox: string): Promise<{ userId: string; warning?: string }> {
    if (this.deps.cfg.AUTH_MODE === "dev") return { userId: mailbox };
    const known = (await this.users.list())
      .filter((u) => u.id !== ADMIN_DASHBOARD_ID && u.email.toLowerCase() === mailbox)
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))[0];
    if (known) return { userId: known.id };
    return { userId: mailbox, warning: `${mailbox} has not used the add-in yet: its messages are stored under the address. Open the add-in once with this account, then import again so the add-in finds them.` };
  }
}

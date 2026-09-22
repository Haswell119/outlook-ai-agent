import type { EmailContext, IndexEmailsResponse } from "@oao/shared";
import { IndexEmailsResponseSchema, safeExternalLink } from "@oao/shared";
import { isVectorWriteError } from "../adapters/db/errors.js";
import type { IndexedChunk } from "../ports/repositories.js";
import { chunkText, normalizeWhitespace } from "../util/text.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";

/** Chunks emails, embeds them when possible (EMBEDDINGS_ENABLED + provider healthy) and upserts by user + email id. */
export class IndexEmailsService {
  private embeddingsHealthy = true;
  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  get embeddingsAvailable(): boolean {
    return Boolean(this.deps.embeddings) && this.deps.cfg.EMBEDDINGS_ENABLED && this.embeddingsHealthy;
  }

  /**
   * Index the email unless it already is (an email is immutable, so "already
   * stored" is enough). Never throws: this runs on the analysis path, where a
   * broken index must not cost the user their summary. Returns `true` when the
   * email was indexed by this call.
   */
  async ensureIndexed(ctx: RequestContext, email: EmailContext): Promise<boolean> {
    try {
      if (await this.deps.repos.emailIndex.hasEmail(ctx.user.id, email.id)) return false;
      const r = await this.index(ctx, [email], { audit: false });
      return r.indexed > 0;
    } catch (e) {
      this.deps.logger.warn({ err: (e as Error).message, emailId: email.id }, "auto-index after analysis failed; the email stays searchable only once indexed explicitly");
      return false;
    }
  }

  /**
   * Index a batch of emails. **Never fails because of the vector store.**
   *
   * Three independent degradations are handled, each of which used to be a 500:
   *  1. the embedding endpoint is down → the rest of the batch is lexical;
   *  2. the stored `vector(N)` column does not match `EMBEDDING_DIMENSIONS`
   *     (the "migrated before the .env existed" case) → detected *before*
   *     writing, so nothing is even attempted;
   *  3. the write on the vector column fails anyway → the chunk is re-inserted
   *     **without** its embedding and the batch continues.
   *
   * In all three cases the response carries `mode: "lexical"` and a `warning`
   * (contract field) so the add-in can tell the user that semantic search is
   * degraded while keyword search still works.
   */
  async index(ctx: RequestContext, emails: EmailContext[], opts: { audit?: boolean } = {}): Promise<IndexEmailsResponse> {
    const { user } = ctx;
    const repo = this.deps.repos.emailIndex;
    let indexed = 0;
    let skipped = 0;
    let mode: "hybrid" | "lexical" = "lexical";
    const warnings: string[] = [];
    const addWarning = (w: string) => {
      if (!warnings.includes(w)) warnings.push(w);
    };

    let vectorsPossible = this.embeddingsAvailable && (await repo.supportsVectors());
    if (this.embeddingsAvailable && !vectorsPossible) {
      const dims = await repo.vectorDimensions?.().catch(() => undefined);
      const configured = this.deps.cfg.EMBEDDING_DIMENSIONS;
      addWarning(
        typeof dims === "number" && dims !== configured
          ? `stored without embeddings: vector dimension mismatch (column ${dims}, config ${configured}) — keyword search only. Fix EMBEDDING_DIMENSIONS or re-run the migration job, then re-index.`
          : "stored without embeddings: the vector store is unavailable (pgvector missing) — keyword search only.",
      );
    }
    // The embedding provider and the column must agree too: a provider that
    // returns 256 values can never be stored in a vector(1536) column.
    if (vectorsPossible && this.deps.embeddings) {
      const dims = await repo.vectorDimensions?.().catch(() => undefined);
      const providerDims = this.deps.embeddings.dimensions;
      if (typeof dims === "number" && typeof providerDims === "number" && providerDims > 0 && providerDims !== dims) {
        vectorsPossible = false;
        addWarning(`stored without embeddings: the embedding model returns ${providerDims} values but the index column is vector(${dims}) — keyword search only.`);
        this.deps.logger.warn({ providerDims, columnDims: dims }, "embedding provider dimension does not match the index column; indexing lexically");
      }
    }

    let embeddingsDown = false;
    for (const email of emails) {
      const chunks = buildChunks(user.id, email);
      if (!chunks.length) {
        skipped++;
        continue;
      }
      if (vectorsPossible && this.deps.embeddings && !embeddingsDown) {
        try {
          const vectors = await this.deps.embeddings.embed(chunks.map((c) => `${c.subject}\n${c.bodyText}`));
          chunks.forEach((c, i) => (c.embedding = vectors[i]));
          mode = "hybrid";
        } catch (e) {
          // One failure per batch is enough: the endpoint is down or has no
          // /embeddings route — do not retry for every remaining email.
          embeddingsDown = true;
          this.deps.logger.warn({ err: (e as Error).message, remaining: emails.length }, "embedding failed, indexing the rest of this batch lexically only (set EMBEDDINGS_ENABLED=false if the endpoint has no /embeddings)");
          this.embeddingsHealthy = false;
          setTimeout(() => (this.embeddingsHealthy = true), 60_000).unref?.();
          addWarning(`stored without embeddings: the embedding model is unavailable (${truncateError(e)}) — keyword search only.`);
        }
      }
      try {
        await repo.upsertEmail(user.id, chunks);
      } catch (e) {
        // Last line of defence: the vector column rejected the write. Store the
        // chunks without their embedding rather than failing the request.
        if (!chunks.some((c) => c.embedding) || !isVectorWriteError(e)) throw e;
        this.deps.logger.error({ err: (e as Error).message, code: (e as { code?: string }).code, emailId: email.id }, "storing the email without its embedding: the vector column rejected the write");
        for (const c of chunks) delete c.embedding;
        await repo.upsertEmail(user.id, chunks);
        vectorsPossible = false;
        mode = "lexical";
        addWarning(`stored without embeddings: the vector column rejected the write (${truncateError(e)}) — keyword search only. Re-index after fixing EMBEDDING_DIMENSIONS or running the migration job.`);
      }
      indexed++;
    }
    const warning = warnings.length ? warnings.join(" ") : undefined;
    if (opts.audit !== false) {
      await this.audit.record({ user, type: "emails_indexed", approvalStatus: "auto_approved", correlationId: ctx.correlationId, details: { indexed, skipped, mode, warning, emailIds: emails.slice(0, 50).map((e) => e.id) } });
    }
    return IndexEmailsResponseSchema.parse({ indexed, skipped, mode, warning });
  }
}

/** First line of an error message, bounded — it ends up in an API response. */
const truncateError = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0]!.slice(0, 160);
};

export function buildChunks(userId: string, email: EmailContext): IndexedChunk[] {
  const attachmentText = email.attachments.map((a) => a.textContent ?? "").filter(Boolean).join("\n\n");
  const body = normalizeWhitespace(`${email.body}${attachmentText ? `\n\n${attachmentText}` : ""}`);
  const parts = chunkText(body || email.bodyPreview || "", 1200, 100);
  if (!parts.length && !email.subject) return [];
  const texts = parts.length ? parts : [email.subject];
  const base = {
    userId,
    emailId: email.id,
    conversationId: email.conversationId,
    internetMessageId: email.internetMessageId,
    subject: email.subject,
    fromName: email.from?.name,
    fromAddress: email.from?.address?.toLowerCase(),
    receivedAt: email.receivedAt ?? email.sentAt,
    folder: email.folder,
    // Sanitised at ingestion: an unsafe scheme must never reach the index, the
    // search sources or the daily brief.
    webLink: safeExternalLink(email.webLink),
    hasAttachments: email.attachments.filter((a) => !a.isInline).length > 0,
    attachmentNames: email.attachments.filter((a) => !a.isInline).map((a) => a.name),
  };
  return texts.map((bodyText, chunkNo) => ({ ...base, chunkNo, bodyText }));
}

import type { EmailContext, IndexEmailsResponse } from "@oao/shared";
import { IndexEmailsResponseSchema, safeExternalLink } from "@oao/shared";
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

  async index(ctx: RequestContext, emails: EmailContext[], opts: { audit?: boolean } = {}): Promise<IndexEmailsResponse> {
    const { user } = ctx;
    let indexed = 0;
    let skipped = 0;
    let mode: "hybrid" | "lexical" = "lexical";
    const vectorsPossible = this.embeddingsAvailable && (await this.deps.repos.emailIndex.supportsVectors());

    for (const email of emails) {
      const chunks = buildChunks(user.id, email);
      if (!chunks.length) {
        skipped++;
        continue;
      }
      if (vectorsPossible && this.deps.embeddings) {
        try {
          const vectors = await this.deps.embeddings.embed(chunks.map((c) => `${c.subject}\n${c.bodyText}`));
          chunks.forEach((c, i) => (c.embedding = vectors[i]));
          mode = "hybrid";
        } catch (e) {
          this.deps.logger.warn({ err: (e as Error).message }, "embedding failed, indexing lexically only");
          this.embeddingsHealthy = false;
          setTimeout(() => (this.embeddingsHealthy = true), 60_000).unref?.();
        }
      }
      await this.deps.repos.emailIndex.upsertEmail(user.id, chunks);
      indexed++;
    }
    if (opts.audit !== false) {
      await this.audit.record({ user, type: "emails_indexed", approvalStatus: "auto_approved", correlationId: ctx.correlationId, details: { indexed, skipped, mode, emailIds: emails.slice(0, 50).map((e) => e.id) } });
    }
    return IndexEmailsResponseSchema.parse({ indexed, skipped, mode });
  }
}

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

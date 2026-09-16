import type { SearchRequest, SearchResponse, SearchSource } from "@oao/shared";
import { SearchResponseSchema } from "@oao/shared";
import type { IndexHit, IndexSearchFilter } from "../ports/repositories.js";
import { bestExcerpt } from "../util/text.js";
import type { AuditService } from "./AuditService.js";
import type { RequestContext, ServiceDeps } from "./context.js";
import type { IndexEmailsService } from "./IndexEmailsService.js";

export type SearchMode = "hybrid" | "lexical" | "vector";

/**
 * Hybrid retrieval: lexical (tsvector / token overlap) + vector (pgvector cosine)
 * fused with reciprocal-rank fusion, one result per email (best chunk).
 */
export class SearchService {
  /**
   * Set when the vector half of the retrieval failed (embedding endpoint down,
   * dimension mismatch between the query vector and the column…). Retrieval
   * stays lexical-only until it expires instead of paying for — and logging —
   * the same failure on every keystroke.
   */
  private vectorDisabledUntil = 0;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly audit: AuditService,
    private readonly indexer: IndexEmailsService,
  ) {}

  /**
   * Hybrid retrieval that always answers. The lexical half runs first and
   * unconditionally; the vector half is best effort, so a broken vector store
   * (the classic `vector(1024)` column with `EMBEDDING_DIMENSIONS=1536`)
   * degrades search to `mode: "lexical"` instead of returning a 500. Chat
   * retrieval goes through here too, so it degrades identically.
   */
  async retrieve(userId: string, query: string, filter: IndexSearchFilter, limit: number): Promise<{ results: SearchSource[]; mode: SearchMode }> {
    const repo = this.deps.repos.emailIndex;
    const fetchN = Math.max(limit * 3, 20);
    const lexical = await repo.searchLexical(userId, query, filter, fetchN);
    let vector: IndexHit[] = [];
    let vectorTried = false;
    const vectorAllowed = Date.now() >= this.vectorDisabledUntil;
    if (vectorAllowed && this.indexer.embeddingsAvailable && this.deps.embeddings && (await repo.supportsVectors().catch(() => false))) {
      try {
        const [embedding] = await this.deps.embeddings.embed([query]);
        if (embedding) {
          vector = await repo.searchVector(userId, embedding, filter, fetchN);
          vectorTried = true;
        }
      } catch (e) {
        // Never rethrow: lexical results are already in hand.
        this.vectorDisabledUntil = Date.now() + 60_000;
        this.deps.logger.warn({ err: (e as Error).message, code: (e as { code?: string }).code, lexicalHits: lexical.length }, "vector search failed, falling back to lexical only for the next minute");
      }
    }
    const mode: SearchMode = vectorTried && vector.length ? (lexical.length ? "hybrid" : "vector") : "lexical";
    const fused = fuse(lexical, vector);
    const max = fused[0]?.score ?? 1;
    const results = fused.slice(0, limit).map(({ hit, score }) => ({
      emailId: hit.chunk.emailId,
      conversationId: hit.chunk.conversationId,
      subject: hit.chunk.subject,
      from: hit.chunk.fromName ? `${hit.chunk.fromName}` : hit.chunk.fromAddress,
      date: hit.chunk.receivedAt,
      relevance: Number(Math.min(1, score / max).toFixed(2)),
      excerpt: bestExcerpt(hit.chunk.bodyText, query, 200),
      webLink: hit.chunk.webLink,
    }));
    return { results, mode };
  }

  async search(ctx: RequestContext, req: SearchRequest): Promise<SearchResponse> {
    const { results, mode } = await this.retrieve(ctx.user.id, req.query, { conversationId: req.conversationId, from: req.from, to: req.to }, req.limit);
    const event = await this.audit.record({ user: ctx.user, type: "search_executed", approvalStatus: "auto_approved", correlationId: ctx.correlationId, details: { queryHash: this.audit.hashes(req.query, "").promptHash, results: results.length, mode, conversationId: req.conversationId } });
    return SearchResponseSchema.parse({ query: req.query, results, mode, auditId: event.id });
  }
}

/** Reciprocal-rank fusion (k = 60), keeping the best chunk per email. */
export function fuse(lexical: IndexHit[], vector: IndexHit[], k = 60): Array<{ hit: IndexHit; score: number }> {
  const scores = new Map<string, { hit: IndexHit; score: number }>();
  const add = (list: IndexHit[], weight: number) => {
    list.forEach((hit, rank) => {
      const key = hit.chunk.emailId;
      const contribution = weight / (k + rank + 1);
      const prev = scores.get(key);
      if (prev) {
        prev.score += contribution;
        if (hit.score > prev.hit.score && list === lexical) prev.hit = hit;
      } else scores.set(key, { hit, score: contribution });
    });
  };
  add(lexical, 1);
  add(vector, 1);
  return Array.from(scores.values()).sort((a, b) => b.score - a.score);
}

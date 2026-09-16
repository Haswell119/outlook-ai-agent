import { describe, expect, it, vi } from "vitest";
import { ZodError, z } from "zod";
import { isDatabaseError, isVectorWriteError, type PgErrorLike } from "../../src/adapters/db/errors.js";
import { decideVectorDimensions, mismatchMessage, type VectorColumn } from "../../src/adapters/db/vector-dimensions.js";
import { errorHandler } from "../../src/http/error-handler.js";
import { AppError, LlmError } from "../../src/errors.js";
import { createTestContainer, ctx, sampleEmail } from "../helpers.js";

/**
 * The incident this guards against: a database migrated while the `.env` was
 * missing (so `EMBEDDING_DIMENSIONS` defaulted to 1024) and later configured
 * with `text-embedding-3-small` (1536). Every embedding write then failed with
 * `DatabaseError: expected 1024 dimensions, not 1536` (SQLSTATE 22000), which
 * surfaced as a 500 "unhandled error" on `POST /api/v1/index/emails`.
 */

const col = (dimensions: number | null, table = "email_index", column = "embedding"): VectorColumn => ({ table, column, dimensions });

describe("decideVectorDimensions (pure guard)", () => {
  it("reports lexical-only when pgvector is absent, or when the column is missing", () => {
    const noExt = decideVectorDimensions({ pgvector: false, columns: [], configuredDimensions: 1536, autoMigrate: true });
    expect(noExt).toMatchObject({ action: "no_pgvector", usable: false });
    expect(noExt.detail).toContain("pgvector");

    // Extension installed but the column was never added (older schema).
    const noCol = decideVectorDimensions({ pgvector: true, columns: [col(1536, "other_table", "v")], configuredDimensions: 1536, autoMigrate: false });
    expect(noCol).toMatchObject({ action: "no_pgvector", usable: false });
  });

  it("accepts a matching column, and an unconstrained `vector` column", () => {
    expect(decideVectorDimensions({ pgvector: true, columns: [col(1536)], configuredDimensions: 1536, autoMigrate: false })).toMatchObject({ action: "ok", usable: true, columnDimensions: 1536, mismatched: [] });
    // `vector` without a dimension validates nothing, so it can hold any output.
    expect(decideVectorDimensions({ pgvector: true, columns: [col(null)], configuredDimensions: 1536, autoMigrate: false })).toMatchObject({ action: "ok", usable: true });
  });

  it("re-dimensions in dev (DB_AUTO_MIGRATE=true) and says the embeddings are discarded", () => {
    const d = decideVectorDimensions({ pgvector: true, columns: [col(1024)], configuredDimensions: 1536, autoMigrate: true });
    expect(d.action).toBe("redimension");
    expect(d.usable).toBe(true);
    expect(d.columnDimensions).toBe(1024);
    expect(d.mismatched).toEqual([col(1024)]);
    expect(d.detail).toMatch(/discarded/);
    expect(d.detail).toMatch(/vector\(1536\)/);
  });

  it("refuses in production (DB_AUTO_MIGRATE=false) with the operator-facing message", () => {
    const d = decideVectorDimensions({ pgvector: true, columns: [col(1024)], configuredDimensions: 1536, autoMigrate: false });
    expect(d.action).toBe("refuse");
    expect(d.usable).toBe(false);
    expect(d.detail).toBe("vector dimension mismatch: column 1024, config 1536 — run the migration job or set EMBEDDING_DIMENSIONS=1024");
    expect(d.detail).toBe(mismatchMessage(1024, 1536));
  });

  it("collects every mismatching vector column but reports the embedding column's size", () => {
    const d = decideVectorDimensions({
      pgvector: true,
      columns: [col(768, "other_index", "vec"), col(1024), col(1536, "already_fine", "v")],
      configuredDimensions: 1536,
      autoMigrate: true,
    });
    expect(d.action).toBe("redimension");
    // Two columns are wrong; the number the operator saw in the pgvector error
    // is the one on `email_index.embedding`.
    expect(d.mismatched).toHaveLength(2);
    expect(d.columnDimensions).toBe(1024);
  });

  it("is idempotent: a second decision after re-dimensioning is `ok`", () => {
    const first = decideVectorDimensions({ pgvector: true, columns: [col(1024)], configuredDimensions: 1536, autoMigrate: true });
    expect(first.action).toBe("redimension");
    const second = decideVectorDimensions({ pgvector: true, columns: [col(1536)], configuredDimensions: 1536, autoMigrate: true });
    expect(second.action).toBe("ok");
  });
});

describe("Postgres error classification", () => {
  const pgError = (code: string, message: string): PgErrorLike => Object.assign(new Error(message), { code, severity: "ERROR", routine: "exec_simple_query" });

  it("recognises a driver error by its SQLSTATE, not only by its class", () => {
    expect(isDatabaseError(pgError("22000", "expected 1024 dimensions, not 1536"))).toBe(true);
    expect(isDatabaseError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isDatabaseError(new Error("something else"))).toBe(false);
    expect(isDatabaseError(new AppError("conflict", "nope"))).toBe(false);
    expect(isDatabaseError("not an error")).toBe(false);
  });

  it("recognises the recoverable vector-write failures", () => {
    expect(isVectorWriteError(pgError("22000", "expected 1024 dimensions, not 1536"))).toBe(true);
    expect(isVectorWriteError(pgError("22P02", 'invalid input syntax for type vector: "[1,2"'))).toBe(true);
    expect(isVectorWriteError(pgError("42804", "column embedding is of type vector but expression is of type text"))).toBe(true);
    // A constraint violation or a missing table is *not* about the vector column.
    expect(isVectorWriteError(pgError("23505", "duplicate key value violates unique constraint"))).toBe(false);
    expect(isVectorWriteError(pgError("42P01", 'relation "email_index" does not exist'))).toBe(false);
  });
});

describe("errorHandler mapping", () => {
  const fakeReply = () => {
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      status(code: number) {
        sent.status = code;
        return reply;
      },
      send(body: unknown) {
        sent.body = body;
        return reply;
      },
    };
    return { reply, sent };
  };
  const fakeReq = () => ({ id: "corr-1", log: { error: vi.fn(), warn: vi.fn() } });

  it("maps a DatabaseError to 500 database_error with a safe message and logs the real one", () => {
    const { reply, sent } = fakeReply();
    const req = fakeReq();
    const err = Object.assign(new Error("expected 1024 dimensions, not 1536"), { code: "22000", severity: "ERROR", table: "email_index", column: "embedding" });
    errorHandler(err, req as never, reply as never);
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({
      error: { code: "database_error", message: "A database error occurred while processing the request", details: { sqlState: "22000" }, correlationId: "corr-1" },
    });
    // The driver message (which quotes the schema) must never reach the client…
    expect(JSON.stringify(sent.body)).not.toContain("1024 dimensions");
    // …but it must be in the log, with the correlation id on the request.
    expect(req.log.error).toHaveBeenCalledWith(expect.objectContaining({ code: "22000", table: "email_index" }), "database error");
  });

  it("still maps AppError, ZodError and LlmError, and never answers 'unhandled error'", () => {
    const app = fakeReply();
    errorHandler(AppError.notFound("Automation"), fakeReq() as never, app.reply as never);
    expect(app.sent).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });

    const zod = fakeReply();
    const zodError = z.object({ query: z.string() }).safeParse({}).error as ZodError;
    errorHandler(zodError, fakeReq() as never, zod.reply as never);
    expect(zod.sent).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });

    const llm = fakeReply();
    errorHandler(new LlmError("http", "500 from http://internal-vllm:8000", 500), fakeReq() as never, llm.reply as never);
    expect(llm.sent).toMatchObject({ status: 502, body: { error: { code: "llm_unavailable" } } });
    expect(JSON.stringify(llm.sent.body)).not.toContain("internal-vllm");
  });
});

describe("IndexEmailsService resilience (no 500 on indexing)", () => {
  /** The exact error pgvector raises on a dimension mismatch. */
  const dimensionError = () => Object.assign(new Error("expected 1024 dimensions, not 1536"), { code: "22000", severity: "ERROR", routine: "exec_simple_query" });

  it("stores the chunk without its embedding, continues, and returns mode=lexical + warning", async () => {
    const c = await createTestContainer();
    const repo = c.repos.emailIndex;
    const original = repo.upsertEmail.bind(repo);
    const attempts: Array<{ emailId: string; withEmbedding: boolean }> = [];
    repo.upsertEmail = async (userId, chunks) => {
      const withEmbedding = chunks.some((k) => k.embedding);
      attempts.push({ emailId: chunks[0]!.emailId, withEmbedding });
      // Every write carrying a vector fails, exactly like a vector(1024) column
      // fed 1536 values.
      if (withEmbedding) throw dimensionError();
      return original(userId, chunks);
    };

    const emails = [sampleEmail({ id: "a" }), sampleEmail({ id: "b" })];
    const r = await c.services.indexEmails.index(ctx(), emails);

    expect(r).toMatchObject({ indexed: 2, skipped: 0, mode: "lexical" });
    expect(r.warning).toContain("without embeddings");
    expect(r.warning).toContain("1024 dimensions");
    // Both emails were retried without their embedding and are searchable.
    expect(attempts.filter((a) => !a.withEmbedding)).toHaveLength(2);
    expect(await c.repos.emailIndex.count("dev.user@northbridge.example")).toBe(2);
    const search = await c.services.search.search(ctx(), { query: "vendor risk assessment", limit: 5 });
    expect(search.results.length).toBeGreaterThan(0);
    // The degradation is recorded in the audit trail, like every other event.
    const audited = c.repos.audit.events.find((e) => e.type === "emails_indexed");
    expect(audited?.details).toMatchObject({ mode: "lexical" });
    expect(String(audited?.details.warning)).toContain("without embeddings");
  });

  it("skips embeddings up front (no failed write at all) when the column dimension disagrees", async () => {
    const c = await createTestContainer();
    const repo = c.repos.emailIndex;
    // A Postgres-like repository that knows its column is vector(1024) while the
    // configuration asks for 64 (TEST_ENV) — `supportsVectors()` says no.
    repo.supportsVectors = async () => false;
    (repo as { vectorDimensions?: () => Promise<number> }).vectorDimensions = async () => 1024;
    const embedSpy = vi.spyOn(c.deps.embeddings!, "embed");

    const r = await c.services.indexEmails.index(ctx(), [sampleEmail({ id: "c" })]);

    expect(r).toMatchObject({ indexed: 1, mode: "lexical" });
    expect(r.warning).toBe("stored without embeddings: vector dimension mismatch (column 1024, config 64) — keyword search only. Fix EMBEDDING_DIMENSIONS or re-run the migration job, then re-index.");
    expect(embedSpy).not.toHaveBeenCalled();
  });

  it("propagates a genuine database failure instead of hiding it", async () => {
    const c = await createTestContainer();
    c.repos.emailIndex.upsertEmail = async () => {
      throw Object.assign(new Error('relation "email_index" does not exist'), { code: "42P01", severity: "ERROR" });
    };
    await expect(c.services.indexEmails.index(ctx(), [sampleEmail({ id: "d" })])).rejects.toThrow(/does not exist/);
  });

  it("falls back to lexical retrieval when the vector query fails", async () => {
    const c = await createTestContainer();
    await c.services.indexEmails.index(ctx(), [sampleEmail({ id: "e" })]);
    c.repos.emailIndex.searchVector = async () => {
      throw Object.assign(new Error("different vector dimensions 1536 and 1024"), { code: "22000", severity: "ERROR" });
    };
    const r = await c.services.search.search(ctx(), { query: "vendor risk assessment", limit: 5 });
    expect(r.mode).toBe("lexical");
    expect(r.results.length).toBeGreaterThan(0);
    // Chat retrieval goes through the same path, so it degrades identically.
    const chat = await c.services.chat.chat(ctx(), { message: "What did the vendor send?", scope: {} });
    expect(chat.answer.length).toBeGreaterThan(0);
  });
});

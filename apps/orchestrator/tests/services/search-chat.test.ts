import { beforeEach, describe, expect, it } from "vitest";
import { ChatResponseSchema, SearchResponseSchema } from "@oao/shared";
import { createTestContainer, ctx, sampleEmail, user, type TestContainer } from "../helpers.js";
import { sampleEmails } from "../../src/seed/emails.js";
import { fuse } from "../../src/services/SearchService.js";
import { buildChunks } from "../../src/services/IndexEmailsService.js";

let c: TestContainer;
const emails = sampleEmails(new Date("2025-06-10T12:00:00Z"));
beforeEach(async () => {
  c = await createTestContainer();
  await c.services.indexEmails.index(ctx(), emails);
});

describe("IndexEmailsService", () => {
  it("indexes with embeddings (hybrid), upserts by user + email id and audits", async () => {
    expect(await c.repos.emailIndex.count("dev.user@northbridge.example")).toBe(emails.length);
    const again = await c.services.indexEmails.index(ctx(), [emails[0]!]);
    expect(again).toEqual({ indexed: 1, skipped: 0, mode: "hybrid" });
    expect(await c.repos.emailIndex.count("dev.user@northbridge.example")).toBe(emails.length);
    expect(c.repos.audit.events.filter((e) => e.type === "emails_indexed")).toHaveLength(2);
    const chunks = buildChunks("u", { ...emails[1]!, body: "x ".repeat(2000) });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toMatchObject({ chunkNo: 0, hasAttachments: true, attachmentNames: expect.arrayContaining([expect.stringContaining("Checklist")]) });
    expect(buildChunks("u", { ...emails[0]!, subject: "", body: "" })).toEqual([]);
  });
  it("falls back to lexical mode when embeddings are disabled", async () => {
    const cc = await createTestContainer({ EMBEDDINGS_ENABLED: "false" }, { embeddings: null });
    const r = await cc.services.indexEmails.index(ctx(), emails.slice(0, 3));
    expect(r.mode).toBe("lexical");
    const s = await cc.services.search.search(ctx(), { query: "mandate", limit: 5 });
    expect(s.mode).toBe("lexical");
    expect(s.results.length).toBeGreaterThan(0);
  });
});

describe("SearchService", () => {
  it("hybrid search returns relevant emails first with excerpts, scoped to the user", async () => {
    const r = await c.services.search.search(ctx(), { query: "client approved the mandate", limit: 5 });
    expect(() => SearchResponseSchema.parse(r)).not.toThrow();
    expect(r.mode).toBe("hybrid");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.relevance).toBe(1);
    expect(r.results.slice(0, 3).some((x) => /Mandate Approval/i.test(x.subject))).toBe(true);
    expect(r.results[0]!.excerpt.length).toBeGreaterThan(20);
    const other = await c.services.search.search(ctx(user("someone.else@northbridge.example")), { query: "mandate", limit: 5 });
    expect(other.results).toEqual([]);
  });
  it("honours the conversation and date filters", async () => {
    const conv = await c.services.search.search(ctx(), { query: "report", limit: 10, conversationId: emails[0]!.conversationId });
    expect(conv.results.every((x) => x.conversationId === emails[0]!.conversationId)).toBe(true);
    const dated = await c.services.search.search(ctx(), { query: "report", limit: 10, from: "2025-06-09T00:00:00Z" });
    expect(dated.results.every((x) => (x.date ?? "") >= "2025-06-09")).toBe(true);
  });
  it("reciprocal-rank fusion merges lists and keeps one entry per email", () => {
    const hit = (emailId: string, score: number) => ({ chunk: { userId: "u", emailId, subject: "", bodyText: "", chunkNo: 0 }, score });
    const fused = fuse([hit("a", 1), hit("b", 0.5)], [hit("b", 0.9), hit("c", 0.8)]);
    expect(fused.map((f) => f.hit.chunk.emailId)).toEqual(["b", "a", "c"]);
  });
});

describe("ChatService", () => {
  it("answers with cited sources and evidence, persists the session, audits", async () => {
    const r = await c.services.chat.chat(ctx(), { message: "Find the email where the client approved the mandate", scope: {} });
    expect(() => ChatResponseSchema.parse(r)).not.toThrow();
    expect(r.headline).toBe("Client approval detected");
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.answer).toMatch(/\[\d\]/);
    expect(r.evidence?.quote).toMatch(/approv/i);
    expect(r.evidence?.emailId).toBe(r.sources[0]!.emailId);
    const session = await c.services.chat.getSession(ctx(), r.sessionId);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.sources?.length).toBe(r.sources.length);
    // Follow-up in the same session keeps history.
    const r2 = await c.services.chat.chat(ctx(), { sessionId: r.sessionId, message: "And when was the KYC validated?", scope: {} });
    expect(r2.sessionId).toBe(r.sessionId);
    expect((await c.services.chat.getSession(ctx(), r.sessionId)).messages).toHaveLength(4);
    expect(c.repos.audit.events.filter((e) => e.type === "chat_answered")).toHaveLength(2);
  });
  it("says honestly when nothing matches", async () => {
    const r = await c.services.chat.chat(ctx(user("empty@northbridge.example")), { message: "quantum flux capacitor", scope: {} });
    expect(r.sources).toEqual([]);
    expect(r.evidence).toBeUndefined();
    expect(r.answer).toMatch(/could not find/i);
    expect(r.confidence).toBeLessThanOrEqual(0.4);
  });
  it("uses the current email as source [1] and rejects foreign sessions", async () => {
    const r = await c.services.chat.chat(ctx(user("nobody@northbridge.example")), { message: "What does Sarah need by Friday?", currentEmail: sampleEmail(), scope: {} });
    expect(r.sources[0]!.emailId).toBe("email-1");
    expect(r.evidence?.quote).toMatch(/Friday|approval/);
    await expect(c.services.chat.chat(ctx(), { sessionId: r.sessionId, message: "hi", scope: {} })).rejects.toMatchObject({ code: "not_found" });
  });
  it("degrades when the model is down", async () => {
    c.llm.failing = true;
    const r = await c.services.chat.chat(ctx(), { message: "mandate approval", scope: {} });
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.sources.length).toBeGreaterThan(0);
  });
});

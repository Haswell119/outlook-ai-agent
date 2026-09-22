import { beforeEach, describe, expect, it } from "vitest";
import { ChatResponseSchema, SearchResponseSchema } from "@oao/shared";
import { createTestContainer, ctx, sampleEmail, user, type TestContainer } from "../helpers.js";
import { sampleEmails } from "../../src/seed/emails.js";
import { fuse } from "../../src/services/SearchService.js";
import { termOverlap } from "../../src/services/ChatService.js";
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
  it("says honestly when nothing matches — and does not call the model for it", async () => {
    const before = c.llm.calls;
    const r = await c.services.chat.chat(ctx(user("empty@northbridge.example")), { message: "quantum flux capacitor", scope: {} });
    expect(r.sources).toEqual([]);
    expect(r.evidence).toBeUndefined();
    // An empty index is a different situation from "no match": the user is told which one.
    expect(r.answer).toMatch(/No email is indexed/i);
    expect(r.retrieval).toEqual({ scope: "mailbox", mode: "none", indexedEmails: 0, matched: 0, modelCallSkipped: true });
    expect(r.model).toBe("no-retrieval");
    expect(r.confidence).toBeLessThanOrEqual(0.4);
    expect(c.llm.calls).toBe(before);
    // Lexical-only container: the mock embedding provider matches everything, so "no match" needs keyword search.
    const lex = await createTestContainer({ EMBEDDINGS_ENABLED: "false" }, { embeddings: null });
    await lex.services.indexEmails.index(ctx(), emails);
    const noMatch = await lex.services.chat.chat(ctx(), { message: "quantum flux capacitor", scope: {} });
    expect(noMatch.answer).toMatch(new RegExp(`None of the ${emails.length} indexed emails`));
    expect(noMatch.retrieval).toMatchObject({ indexedEmails: emails.length, matched: 0, modelCallSkipped: true });
    expect(lex.repos.audit.events.filter((e) => e.type === "chat_answered").every((e) => e.details.modelCallSkipped === true)).toBe(true);
  });
  it("conversation scope: the current email is source [1]; foreign sessions are rejected", async () => {
    const r = await c.services.chat.chat(ctx(user("nobody@northbridge.example")), { message: "What does Sarah need by Friday?", currentEmail: sampleEmail(), scope: { conversationId: "conv-1" } });
    expect(r.sources[0]!.emailId).toBe("email-1");
    expect(r.sources[0]!.relevance).toBe(1);
    expect(r.retrieval).toMatchObject({ scope: "conversation" });
    expect(r.evidence?.quote).toMatch(/Friday|approval/);
    await expect(c.services.chat.chat(ctx(), { sessionId: r.sessionId, message: "hi", scope: {} })).rejects.toMatchObject({ code: "not_found" });
  });
  it("mailbox scope ('All emails'): the opened email no longer wins by default", async () => {
    // The user has an unrelated email open and asks about the whole mailbox.
    const opened = sampleEmail({ id: "opened-1", conversationId: "conv-opened", subject: "Lunch on Thursday?", body: "Shall we grab lunch on Thursday near the office?" });
    const r = await c.services.chat.chat(ctx(), { message: "Find the email where the client approved the mandate", currentEmail: opened, scope: {} });
    expect(r.retrieval).toMatchObject({ scope: "mailbox", indexedEmails: emails.length });
    expect(r.retrieval!.modelCallSkipped).toBeUndefined();
    expect(r.retrieval!.matched).toBeGreaterThan(0);
    expect(r.retrieval!.mode).toBe("hybrid");
    // The answer cites an indexed email, not the one that happens to be open.
    expect(r.sources[0]!.emailId).not.toBe("opened-1");
    expect(r.sources.some((x) => /Mandate Approval/i.test(x.subject))).toBe(true);
    expect(r.evidence?.emailId).not.toBe("opened-1");
    // The opened email is still offered to the model, last and ranked on its actual overlap with the question.
    const prompt = c.llm.requests.at(-1)!;
    const userMsg = prompt.messages.at(-1)!.content;
    expect(userMsg).toContain("Retrieval scope: the whole mailbox");
    expect(userMsg).toContain('Email currently opened in Outlook: "Lunch on Thursday?"');
    expect(userMsg).not.toContain("Email currently opened in Outlook (context)"); // not quoted in full any more, only listed as a source
    expect(prompt.messages[0]!.content).toContain("WHOLE mailbox");
    // With a question that IS about the opened email, it is still found (it is the last source, with a low overlap score).
    const about = await c.services.chat.chat(ctx(), { message: "lunch Thursday office", currentEmail: opened, scope: {} });
    expect(about.sources.some((x) => x.emailId === "opened-1")).toBe(true);
    const last = c.llm.requests.at(-1)!.messages.at(-1)!.content;
    expect(last).toMatch(/\[\d+\] Subject: Lunch on Thursday\?/);
  });
  it("mailbox scope with an empty index falls back to the opened email only, and says the index is empty", async () => {
    const r = await c.services.chat.chat(ctx(user("fresh@northbridge.example")), { message: "What does Sarah need by Friday?", currentEmail: sampleEmail(), scope: {} });
    expect(r.retrieval).toMatchObject({ scope: "mailbox", indexedEmails: 0, matched: 0, mode: "none" });
    expect(r.sources.map((x) => x.emailId)).toEqual(["email-1"]);
    expect(r.sources[0]!.relevance).toBeGreaterThan(0);
    expect(r.sources[0]!.relevance).toBeLessThanOrEqual(1);
  });
  it("termOverlap ranks by the share of question terms present", () => {
    expect(termOverlap("mandate approval client", "The client approved the mandate")).toBeGreaterThan(0.6);
    expect(termOverlap("mandate approval client", "Lunch on Thursday")).toBe(0);
    expect(termOverlap("", "anything")).toBe(0);
  });
  it("degrades when the model is down", async () => {
    c.llm.failing = true;
    const r = await c.services.chat.chat(ctx(), { message: "mandate approval", scope: {} });
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.sources.length).toBeGreaterThan(0);
  });
});

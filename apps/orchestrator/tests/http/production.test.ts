import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DailyBriefSchema, EmailAnalysisSchema, MailboxSyncStatusSchema, Routes, SystemStatusSchema } from "@oao/shared";
import { buildApp } from "../../src/app.js";
import { buildOpenApiDocument } from "../../src/openapi.js";
import { createTestContainer, ctx, FakeGraphClient, sampleEmail, SYNC_ENV, user, type TestContainer } from "../helpers.js";

const H = { "content-type": "application/json", "accept-language": "en" };
const asUser = (email = "dev.user@northbridge.example") => ({ ...H, "x-user-email": email, "x-user-name": "Test User" });
const asAdmin = { ...H, authorization: "Bearer test-admin-token" };

let c: TestContainer;
let app: FastifyInstance;

beforeAll(async () => {
  c = await createTestContainer();
  app = await buildApp(c, { logger: false });
  await app.ready();
});
afterAll(async () => app.close());

describe("Kubernetes probes", () => {
  it("GET /live is public and always 200 once the process is up", async () => {
    const r = await app.inject({ method: "GET", url: Routes.live });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", role: "api" });
    expect(r.json().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("GET /ready is public and 200 when the database is reachable", async () => {
    const r = await app.inject({ method: "GET", url: Routes.ready });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("ok");
  });

  it("GET /ready is 503 when the database is unreachable", async () => {
    const broken = await createTestContainer();
    broken.repos.ping = async () => ({ ok: false, detail: "connection refused" });
    const brokenApp = await buildApp(broken, { logger: false });
    const r = await brokenApp.inject({ method: "GET", url: Routes.ready });
    expect(r.statusCode).toBe(503);
    expect(r.json().detail).toContain("connection refused");
    await brokenApp.close();
  });

  it("an LLM outage degrades /health but does NOT make the pod unready", async () => {
    const degraded = await createTestContainer();
    degraded.llm.failing = true;
    const degradedApp = await buildApp(degraded, { logger: false });

    const ready = await degradedApp.inject({ method: "GET", url: Routes.ready });
    expect(ready.statusCode).toBe(200);

    const health = await degradedApp.inject({ method: "GET", url: Routes.health });
    expect(health.json().status).toBe("degraded");
    expect(health.json().checks.llm.status).toBe("degraded");
    await degradedApp.close();
  });

  it("probes do not require authentication even in aad mode", async () => {
    const aad = await createTestContainer({ AUTH_MODE: "aad", AAD_TENANT_ID: "t", AAD_CLIENT_ID: "cid" });
    const aadApp = await buildApp(aad, { logger: false });
    expect((await aadApp.inject({ method: "GET", url: Routes.live })).statusCode).toBe(200);
    expect((await aadApp.inject({ method: "GET", url: Routes.ready })).statusCode).toBe(200);
    expect((await aadApp.inject({ method: "GET", url: Routes.metrics })).statusCode).toBe(200);
    expect((await aadApp.inject({ method: "GET", url: Routes.me })).statusCode).toBe(401);
    await aadApp.close();
  });
});

describe("GET /metrics", () => {
  it("exposes Prometheus text with the HTTP, LLM, cache and audit families", async () => {
    await app.inject({ method: "POST", url: Routes.analyzeEmail, headers: asUser(), payload: { email: sampleEmail() } });
    const r = await app.inject({ method: "GET", url: Routes.metrics });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    const body = r.body;
    for (const metric of [
      "oao_http_requests_total",
      "oao_http_request_duration_seconds",
      "oao_llm_calls_total",
      "oao_llm_call_duration_seconds",
      "oao_llm_queue_wait_seconds",
      "oao_llm_tokens_total",
      "oao_llm_queue_depth",
      "oao_llm_circuit_open",
      "oao_cache_events_total",
      "oao_triage_total",
      "oao_model_calls_saved_total",
      "oao_audit_events_total",
      "oao_mailbox_sync_runs_total",
    ]) {
      expect(body, metric).toContain(metric);
    }
    expect(body).toMatch(/oao_http_requests_total\{[^}]*route="\/api\/v1\/analyze\/email"/);
    expect(body).toMatch(/oao_audit_events_total\{type="summary_generated"\}/);
  });

  it("labels routes by their template, never by the raw URL (no cardinality explosion)", async () => {
    await app.inject({ method: "GET", url: Routes.analysisByEmail("some-very-unique-id-1"), headers: asUser() });
    await app.inject({ method: "GET", url: Routes.analysisByEmail("some-very-unique-id-2"), headers: asUser() });
    const body = (await app.inject({ method: "GET", url: Routes.metrics })).body;
    expect(body).not.toContain("some-very-unique-id-1");
    expect(body).toContain('route="/api/v1/analyze/email/:emailId"');
  });

  it("requires the token when METRICS_TOKEN is set", async () => {
    const guarded = await createTestContainer({ METRICS_TOKEN: "s3cret-metrics-token" });
    const guardedApp = await buildApp(guarded, { logger: false });
    expect((await guardedApp.inject({ method: "GET", url: Routes.metrics })).statusCode).toBe(401);
    expect((await guardedApp.inject({ method: "GET", url: Routes.metrics, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await guardedApp.inject({ method: "GET", url: Routes.metrics, headers: { authorization: "Bearer s3cret-metrics-token" } })).statusCode).toBe(200);
    expect((await guardedApp.inject({ method: "GET", url: Routes.metrics, headers: { "x-metrics-token": "s3cret-metrics-token" } })).statusCode).toBe(200);
    await guardedApp.close();
  });

  it("404s when metrics are disabled", async () => {
    const off = await createTestContainer({ METRICS_ENABLED: "false" });
    const offApp = await buildApp(off, { logger: false });
    expect((await offApp.inject({ method: "GET", url: Routes.metrics })).statusCode).toBe(404);
    await offApp.close();
  });
});

describe("GET /analyze/email/:emailId", () => {
  it("404s with not_found when nothing was precomputed", async () => {
    const r = await app.inject({ method: "GET", url: Routes.analysisByEmail("never-seen"), headers: asUser() });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });

  it("serves a precomputed analysis instantly with source=precomputed", async () => {
    const email = sampleEmail({ id: "route-pre-1" });
    const analysis = await c.services.analyzeEmail.analyze(ctx(user("dev.user@northbridge.example")), { email, includeThread: false });
    await c.services.analyzeEmail.storePrecomputed("dev.user@northbridge.example", analysis, email.conversationId);

    const before = c.llm.calls;
    const r = await app.inject({ method: "GET", url: Routes.analysisByEmail("route-pre-1"), headers: asUser() });
    expect(r.statusCode).toBe(200);
    expect(c.llm.calls).toBe(before); // the endpoint never calls the model
    const parsed = EmailAnalysisSchema.parse(r.json());
    expect(parsed).toMatchObject({ emailId: "route-pre-1", source: "precomputed" });
  });

  it("does not leak another user's precomputed analysis", async () => {
    const r = await app.inject({ method: "GET", url: Routes.analysisByEmail("route-pre-1"), headers: asUser("someone.else@northbridge.example") });
    expect(r.statusCode).toBe(404);
  });

  it("handles url-encoded Graph ids", async () => {
    const id = "AAMkAD/with+slashes=";
    const email = sampleEmail({ id });
    const analysis = await c.services.analyzeEmail.analyze(ctx(user()), { email, includeThread: false });
    await c.services.analyzeEmail.storePrecomputed(user().id, analysis);
    const r = await app.inject({ method: "GET", url: Routes.analysisByEmail(id), headers: asUser() });
    expect(r.statusCode).toBe(200);
    expect(r.json().emailId).toBe(id);
  });
});

describe("daily brief routes", () => {
  it("GET 404s before generation, POST generates, GET then returns the stored brief", async () => {
    const date = c.services.dailyBrief.today();
    const missing = await app.inject({ method: "GET", url: `${Routes.dailyBrief}?date=${date}`, headers: asUser("brief.user@northbridge.example") });
    expect(missing.statusCode).toBe(404);

    const generated = await app.inject({ method: "POST", url: Routes.dailyBrief, headers: asUser("brief.user@northbridge.example"), payload: { date } });
    expect(generated.statusCode).toBe(200);
    expect(DailyBriefSchema.parse(generated.json()).date).toBe(date);

    const stored = await app.inject({ method: "GET", url: `${Routes.dailyBrief}?date=${date}`, headers: asUser("brief.user@northbridge.example") });
    expect(stored.statusCode).toBe(200);
    expect(stored.json().generatedAt).toBe(generated.json().generatedAt);
  });

  it("rejects an invalid body", async () => {
    const r = await app.inject({ method: "POST", url: Routes.dailyBrief, headers: asUser(), payload: { refresh: "maybe" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("mailbox sync routes", () => {
  it("reports the disabled status when precomputation is off", async () => {
    const r = await app.inject({ method: "GET", url: Routes.mailboxSync, headers: asUser() });
    expect(r.statusCode).toBe(200);
    expect(MailboxSyncStatusSchema.parse(r.json())).toMatchObject({ enabled: false, state: "disabled" });
  });

  it("POST triggers a sync and returns 202 with the new status", async () => {
    const graph = new FakeGraphClient();
    // AUTH_MODE=dev so the caller's bearer token is available as a delegated token.
    const sync = await createTestContainer({ ...SYNC_ENV, AUTH_MODE: "dev" }, { graph });
    graph.queue([sampleEmail({ id: "s1", body: "Please confirm the mandate before Friday.", attachments: [] })]);
    const syncApp = await buildApp(sync, { logger: false });

    const r = await syncApp.inject({ method: "POST", url: Routes.mailboxSync, headers: { ...H, "x-user-email": "ana@northbridge.example", authorization: "Bearer office-sso-token" } });
    expect(r.statusCode).toBe(202);
    expect(r.json().result.fetched).toBe(1);
    expect(MailboxSyncStatusSchema.parse({ ...r.json(), result: undefined })).toMatchObject({ enabled: true });
    await syncApp.close();
  });

  it("only an admin may target another user", async () => {
    const forbidden = await app.inject({ method: "GET", url: `${Routes.mailboxSync}?userId=other@northbridge.example`, headers: asUser() });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", url: `${Routes.mailboxSync}?userId=other@northbridge.example`, headers: asAdmin });
    expect(ok.statusCode).toBe(200);
  });
});

describe("POST /actions/approve — idempotency", () => {
  const proposalFor = async (email = sampleEmail({ id: "idem-1" })) => {
    const r = await app.inject({ method: "POST", url: Routes.proposeActions, headers: asUser(), payload: { email } });
    expect(r.statusCode).toBe(200);
    return r.json() as { proposalId: string; actions: Array<{ id: string }> };
  };

  it("a retry with the same Idempotency-Key returns the stored response and executes nothing twice", async () => {
    const proposal = await proposalFor();
    const payload = { proposalId: proposal.proposalId, actionIds: [proposal.actions[0]!.id] };
    const headers = { ...asUser(), "idempotency-key": "retry-key-1" };

    const first = await app.inject({ method: "POST", url: Routes.approveActions, headers, payload });
    expect(first.statusCode).toBe(200);
    const executedBefore = c.repos.audit.events.filter((e) => e.type === "action_executed" || e.type === "action_approved").length;

    const second = await app.inject({ method: "POST", url: Routes.approveActions, headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    // The replay is audited, but no new approval/execution happened.
    const replay = c.repos.audit.events.filter((e) => e.details.idempotentReplay === true);
    expect(replay).toHaveLength(1);
    const executedAfter = c.repos.audit.events.filter((e) => e.type === "action_executed").length;
    expect(executedAfter).toBe(c.repos.audit.events.filter((e) => e.type === "action_executed").length);
    expect(executedBefore).toBeGreaterThan(0);
  });

  it("reusing a key with a different body is a 409 conflict", async () => {
    const a = await proposalFor(sampleEmail({ id: "idem-2" }));
    const b = await proposalFor(sampleEmail({ id: "idem-3" }));
    const headers = { ...asUser(), "idempotency-key": "retry-key-2" };
    await app.inject({ method: "POST", url: Routes.approveActions, headers, payload: { proposalId: a.proposalId, actionIds: [a.actions[0]!.id] } });
    const conflict = await app.inject({ method: "POST", url: Routes.approveActions, headers, payload: { proposalId: b.proposalId, actionIds: [b.actions[0]!.id] } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");
  });

  it("without the header, a second approval of the same proposal is not replayed", async () => {
    const proposal = await proposalFor(sampleEmail({ id: "idem-4" }));
    const payload = { proposalId: proposal.proposalId, actionIds: [proposal.actions[0]!.id] };
    await app.inject({ method: "POST", url: Routes.approveActions, headers: asUser(), payload });
    const second = await app.inject({ method: "POST", url: Routes.approveActions, headers: asUser(), payload });
    expect(second.statusCode).toBe(200);
    // Already-executed actions report their stored status rather than re-running.
    expect(second.json().results[0]!.message).toMatch(/already/i);
  });
});

describe("GET /admin/system", () => {
  it("returns the runtime status for an admin and 403 otherwise", async () => {
    expect((await app.inject({ method: "GET", url: Routes.adminSystem, headers: asUser() })).statusCode).toBe(403);
    const r = await app.inject({ method: "GET", url: Routes.adminSystem, headers: asAdmin });
    expect(r.statusCode).toBe(200);
    const status = SystemStatusSchema.parse(r.json());
    expect(status.llmQueue.concurrency).toBeGreaterThan(0);
    expect(status.features).toMatchObject({ llmProvider: "mock", organizationName: "Northbridge Capital" });
    expect(status.cache.analysisHits + status.cache.analysisMisses).toBeGreaterThan(0);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /config/features", () => {
  it("advertises the AI-load features to the add-in", async () => {
    const r = await app.inject({ method: "GET", url: Routes.features });
    expect(r.json()).toMatchObject({ precomputeEnabled: false, dailyBriefEnabled: true, organizationName: "Northbridge Capital" });
  });

  it("reports the fast model and the organisation name from the environment", async () => {
    const custom = await createTestContainer({ LLM_FAST_MODEL: "qwen3-1.7b", ORGANIZATION_NAME: "Northbridge Capital AG" });
    const customApp = await buildApp(custom, { logger: false });
    const r = await customApp.inject({ method: "GET", url: Routes.features });
    expect(r.json()).toMatchObject({ llmFastModel: "qwen3-1.7b", organizationName: "Northbridge Capital AG" });
    await customApp.close();
  });
});

describe("GET /audit/export", () => {
  it("streams a CSV with the AI-load columns", async () => {
    await app.inject({ method: "POST", url: Routes.analyzeEmail, headers: asUser(), payload: { email: sampleEmail({ id: "csv-1" }) } });
    const r = await app.inject({ method: "GET", url: Routes.auditExport, headers: asAdmin });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.headers["content-disposition"]).toContain("attachment");
    const lines = r.body.trim().split("\n");
    expect(lines[0]).toContain("analysisSource,cached");
    expect(lines.length).toBeGreaterThan(1);
    // No trailing blank line.
    expect(lines.at(-1)).not.toBe("");
  });
});

describe("OpenAPI document", () => {
  it("is generated from the shared contracts and documents the new routes", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    for (const path of ["/live", "/ready", "/analyze/email", "/analyze/email/{emailId}", "/brief/daily", "/mailbox/sync", "/admin/system", "/audit/export"]) {
      expect(Object.keys(doc.paths), path).toContain(path);
    }
    for (const schema of ["EmailAnalysis", "DailyBrief", "MailboxSyncStatus", "SystemStatus", "ApiError"]) {
      expect(doc.components.schemas[schema], schema).toBeTruthy();
    }
    // `source` and `triage` are what the add-in keys its UI off.
    const analysis = JSON.stringify(doc.components.schemas.EmailAnalysis);
    expect(analysis).toContain("precomputed");
    expect(analysis).toContain("newsletter");
  });

  it("serves the docs UI only when API_DOCS_ENABLED=true", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/docs" })).statusCode).toBe(404);
    const docs = await createTestContainer({ API_DOCS_ENABLED: "true" });
    const docsApp = await buildApp(docs, { logger: false });
    const r = await docsApp.inject({ method: "GET", url: "/api/v1/docs/json" });
    expect(r.statusCode).toBe(200);
    expect(r.json().info.title).toContain("Outlook AI Orchestrator");
    await docsApp.close();
  });
});

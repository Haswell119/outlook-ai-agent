import { describe, expect, it } from "vitest";
import { HealthSchema, Routes, SystemStatusSchema } from "@oao/shared";
import { MockDecisionProvider } from "../../src/adapters/decision/mock.js";
import { buildApp } from "../../src/app.js";
import { createContainer } from "../../src/container.js";
import { loadConfig } from "../../src/config.js";
import { createTestContainer, ctx, sampleEmail, TEST_ENV } from "../helpers.js";

const asAdmin = { authorization: "Bearer test-admin-token" };
const email = () => sampleEmail({ subject: "Import NAV bloqué", body: "Bonjour, le fichier des positions NAV manque. Pouvez-vous confirmer le report ?", attachments: [] });

async function appWith(env: NodeJS.ProcessEnv, mock = new MockDecisionProvider()) {
  const c = await createTestContainer({ DECISION_PROVIDER: "mock", LAYA_MODE: "active", LAYA_CIRCUIT_FAILURE_THRESHOLD: "1", LAYA_API_KEY: "status-test-key-81c4", ...env }, { decisionProvider: mock });
  const app = await buildApp(c, { logger: false });
  await app.ready();
  return { c, app, mock };
}

describe("Laya in the probes and status endpoints", () => {
  it("/ready stays 200 while the engine is down; /health reports it degraded (active mode)", async () => {
    const { c, app, mock } = await appWith({}, new MockDecisionProvider().failWith("network"));
    mock.health = { status: "unavailable", detail: "network" };
    await c.services.analyzeEmail.analyze(ctx(), { email: email(), includeThread: false }); // opens the circuit (threshold 1)
    expect(c.decisionResilience?.circuitState).toBe("open");

    const ready = await app.inject({ method: "GET", url: Routes.ready });
    expect(ready.statusCode).toBe(200);
    const live = await app.inject({ method: "GET", url: Routes.live });
    expect(live.statusCode).toBe(200);

    const health = HealthSchema.parse((await app.inject({ method: "GET", url: Routes.health })).json());
    expect(health.checks.laya).toMatchObject({ status: "degraded" });
    expect(health.checks.laya?.detail).toMatch(/^unavailable: circuit open/);
    expect(health.status).toBe("degraded");
    await app.close();
  });

  it("shadow mode: the engine being down does not degrade the overall status", async () => {
    const mock = new MockDecisionProvider();
    mock.health = { status: "unavailable", detail: "network" };
    const { app } = await appWith({ LAYA_MODE: "shadow" }, mock);
    const health = HealthSchema.parse((await app.inject({ method: "GET", url: Routes.health })).json());
    expect(health.checks.laya?.status).toBe("degraded");
    expect(health.status).toBe("ok");
    await app.close();
  });

  it("disabled: no laya check at all, historic /health", async () => {
    const c = await createTestContainer();
    const app = await buildApp(c, { logger: false });
    const health = HealthSchema.parse((await app.inject({ method: "GET", url: Routes.health })).json());
    expect(health.checks).not.toHaveProperty("laya");
    const status = SystemStatusSchema.parse((await app.inject({ method: "GET", url: Routes.adminSystem, headers: asAdmin })).json());
    expect(status.decisioning).toMatchObject({ provider: "disabled", state: "disabled", circuit: "closed" });
    await app.close();
  });

  it("/admin/system shows the engine's configuration and counters — never the key, the URL or content", async () => {
    const { c, app } = await appWith({ LAYA_BASE_URL: "http://laya-internal.svc:8000" });
    await c.services.analyzeEmail.analyze(ctx(), { email: sampleEmail({ subject: "CANARY-subject NAV", body: "CANARY-body: pouvez-vous confirmer l'import NAV ?", attachments: [] }), includeThread: false });
    const res = await app.inject({ method: "GET", url: Routes.adminSystem, headers: asAdmin });
    expect(res.statusCode).toBe(200);
    const status = SystemStatusSchema.parse(res.json());
    expect(status.decisioning).toMatchObject({
      provider: "mock",
      mode: "active",
      state: "ok",
      circuit: "closed",
      modelStrategy: "language",
      taxonomyVersion: "v1",
      decisionVersion: "v1",
      minConfidence: 0.75,
      folderMinConfidence: 0.8,
      fallbackToLlm: true,
      concurrency: 1,
      loadedModels: ["mock-english", "mock-multilingual"],
      stats: { decisions: 1, providerCalls: expect.any(Number), failures: 0 },
    });
    expect(res.body).not.toContain("status-test-key-81c4");
    expect(res.body).not.toContain("laya-internal.svc");
    expect(res.body).not.toContain("CANARY");
    // Admin only.
    const denied = await app.inject({ method: "GET", url: Routes.adminSystem, headers: { "x-user-email": "dev.user@northbridge.example" } });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it("/metrics exposes the oao_laya_* families", async () => {
    const { c, app } = await appWith({});
    await c.services.analyzeEmail.analyze(ctx(), { email: email(), includeThread: false });
    const body = (await app.inject({ method: "GET", url: Routes.metrics })).body;
    for (const family of ["oao_laya_requests_total", "oao_laya_request_duration_seconds", "oao_laya_circuit_state", "oao_laya_decisions_total", "oao_laya_model_calls_saved_total"]) expect(body).toContain(family);
    expect(body).toMatch(/oao_laya_requests_total\{outcome="ok"\} \d+/);
    expect(body).toMatch(/oao_laya_circuit_state 0/);
    // Labels stay bounded: taxonomy ids, never subjects or addresses.
    expect(body).toMatch(/oao_laya_decisions_total\{question="businessArea",choice="[a-z_]+"\}/);
    expect(body).not.toMatch(/NAV bloqué|northbridge\.example/);
    await app.close();
  });

  it("an invalid taxonomy file stops the boot with a configuration error", async () => {
    const cfg = loadConfig({ ...TEST_ENV, DECISION_PROVIDER: "mock", LAYA_TAXONOMY_FILE: "/nonexistent/taxonomy.json" });
    await expect(createContainer(cfg)).rejects.toThrow(/LAYA_TAXONOMY_FILE \(\/nonexistent\/taxonomy.json\): cannot read the file/);
  });
});

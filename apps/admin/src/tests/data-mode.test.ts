import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The probe carries no session headers here: only the data-mode logic is under test.
vi.mock("@/lib/session", () => ({ getAdminSession: async () => null }));

const ORCHESTRATOR = "http://127.0.0.1:9999";

async function freshApi(vars: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  (globalThis as { __oaoAdminMode?: unknown }).__oaoAdminMode = undefined;
  const { resetEnvCache } = await import("@/env");
  resetEnvCache();
  return import("@/lib/api");
}

describe("live / demo data mode", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("probes /live, not /health: a slow model or decision engine must not switch the dashboard to demo data", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    });
    const api = await freshApi({ ORCHESTRATOR_URL: ORCHESTRATOR, ADMIN_MOCK: "false" });
    expect(await api.dataMode()).toBe("live");
    expect(calls).toEqual([`${ORCHESTRATOR}/api/v1/live`]);
    expect(await api.mockReason()).toBeUndefined();
  });

  it("an unreachable orchestrator gives the demo dataset, with the URL and the socket error as the reason", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED ::1:8080"), { code: "ECONNREFUSED", address: "::1", port: 8080 }) });
    });
    const api = await freshApi({ ORCHESTRATOR_URL: ORCHESTRATOR, ADMIN_MOCK: "false" });
    expect(await api.dataMode()).toBe("mock");
    expect(await api.mockReason()).toBe(`${ORCHESTRATOR}: fetch failed (ECONNREFUSED ::1:8080)`);
  });

  it("every attempt of Node's happy eyeballs is listed", async () => {
    const { describeError } = await freshApi({ ORCHESTRATOR_URL: ORCHESTRATOR });
    const attempt = (code: string, address: string, port: number) => Object.assign(new Error(code), { code, address, port });
    const err = new TypeError("fetch failed", { cause: new AggregateError([attempt("ETIMEDOUT", "127.0.0.1", 8080), attempt("ECONNREFUSED", "::1", 8080)]) });
    expect(describeError(err)).toBe("fetch failed (ETIMEDOUT 127.0.0.1:8080, ECONNREFUSED ::1:8080)");
    expect(describeError(new Error("The operation was aborted due to timeout"))).toBe("The operation was aborted due to timeout");
  });

  it("ADMIN_MOCK=true serves the demo dataset without calling the orchestrator, and says why", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    });
    const api = await freshApi({ ORCHESTRATOR_URL: ORCHESTRATOR, ADMIN_MOCK: "true" });
    expect(await api.dataMode()).toBe("mock");
    expect(await api.mockReason()).toBe("ADMIN_MOCK=true");
    expect(calls).toEqual([]);
  });
});

describe("default time window", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("with live data the last 7 / 30 days end today; in demo mode they stay on the dataset's week", async () => {
    const { resolveQuery, DEFAULT_PERIOD } = await import("@/lib/query");
    expect(resolveQuery({})).toMatchObject({ preset: "last7", from: DEFAULT_PERIOD.from, to: DEFAULT_PERIOD.to });
    expect(resolveQuery({ range: "last30" }).from).toBe("2025-04-19T00:00:00.000Z");

    const now = new Date("2026-09-30T15:00:00Z");
    expect(resolveQuery({}, now)).toMatchObject({ from: "2026-09-24T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" });
    expect(resolveQuery({ range: "last30" }, now)).toMatchObject({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" });
    // An explicit range is kept as asked, whatever the mode.
    expect(resolveQuery({ range: "custom", from: "2026-01-01", to: "2026-01-31" }, now)).toMatchObject({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-31T23:59:59.999Z" });
  });

  it("periodAnchor: today with live data, none in demo mode", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const live = await freshApi({ ORCHESTRATOR_URL: ORCHESTRATOR, ADMIN_MOCK: "false" });
    const anchor = await live.periodAnchor();
    expect(anchor).toBeInstanceOf(Date);
    expect(Math.abs(anchor!.getTime() - Date.now())).toBeLessThan(60_000);
    const demo = await freshApi({ ORCHESTRATOR_URL: ORCHESTRATOR, ADMIN_MOCK: "true" });
    expect(await demo.periodAnchor()).toBeUndefined();
  });
});

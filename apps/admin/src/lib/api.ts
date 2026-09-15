/**
 * Server-side data access for the admin dashboard.
 *
 * Every helper here runs on the server only (Server Components and route
 * handlers) so that `ADMIN_API_TOKEN` never reaches the browser.
 *
 * Two modes:
 *  - `ADMIN_MOCK=true`             → the deterministic dataset in `./mock-data`.
 *  - otherwise                     → the orchestrator at `ORCHESTRATOR_URL`;
 *    outside production a failed call logs a warning and degrades to the mock
 *    dataset so the dashboard is always demoable.
 */
import "server-only";
import { cookies } from "next/headers";
import {
  AuditPageSchema,
  AuditStatsSchema,
  AuditEventSchema,
  AutomationSchema,
  EscalationSchema,
  FeatureFlagsSchema,
  HealthSchema,
  PolicySchema,
  Routes,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
  type AuditStats,
  type Automation,
  type Escalation,
  type FeatureFlags,
  type Health,
  type Language,
  type Policy,
} from "@oao/shared";
import { z } from "zod";
import { LANGUAGE_COOKIE, isLanguage } from "./i18n";
import { AdminUsersResponseSchema, type AdminUser, type DataMode } from "./types";
import {
  MOCK_PERIOD,
  buildStats,
  filterEvents,
  mockAuditPage,
  mockFeatures,
  mockHealth,
  store,
} from "./mock-data";

/* --------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* --------------------------------------------------------------------------- */

export interface AdminConfig {
  orchestratorUrl: string;
  token: string;
  forceMock: boolean;
  tenantName: string;
  defaultLanguage: Language;
  isProduction: boolean;
}

export function adminConfig(): AdminConfig {
  const defaultLanguage = process.env.ADMIN_DEFAULT_LANGUAGE;
  return {
    orchestratorUrl: (process.env.ORCHESTRATOR_URL ?? "http://localhost:8080").replace(/\/+$/, ""),
    token: process.env.ADMIN_API_TOKEN ?? "",
    forceMock: process.env.ADMIN_MOCK === "true",
    tenantName: process.env.ADMIN_TENANT_NAME ?? "ABC Capital",
    defaultLanguage: isLanguage(defaultLanguage) ? defaultLanguage : "en",
    isProduction: process.env.NODE_ENV === "production",
  };
}

export async function currentLanguage(): Promise<Language> {
  try {
    const jar = await cookies();
    const value = jar.get(LANGUAGE_COOKIE)?.value;
    if (isLanguage(value)) return value;
  } catch {
    /* outside a request scope (e.g. during a static probe) */
  }
  return adminConfig().defaultLanguage;
}

/* --------------------------------------------------------------------------- */
/*  Mode resolution & fetch plumbing                                           */
/* --------------------------------------------------------------------------- */

interface ModeCache {
  mode: DataMode;
  checkedAt: number;
  warned: boolean;
}

const globalMode = globalThis as unknown as { __oaoAdminMode?: ModeCache };
const PROBE_TTL_MS = 15_000;

function degradeToMock(reason: string): DataMode {
  const cfg = adminConfig();
  if (cfg.isProduction) return "live";
  const cache = globalMode.__oaoAdminMode;
  if (!cache?.warned) {
    // eslint-disable-next-line no-console
    console.warn(
      `[@oao/admin] orchestrator unreachable at ${cfg.orchestratorUrl} (${reason}) — falling back to ADMIN_MOCK data.`,
    );
  }
  globalMode.__oaoAdminMode = { mode: "mock", checkedAt: Date.now(), warned: true };
  return "mock";
}

/** Resolved once per 15 s so a dead orchestrator does not slow every render. */
export async function dataMode(): Promise<DataMode> {
  const cfg = adminConfig();
  if (cfg.forceMock) return "mock";
  const cache = globalMode.__oaoAdminMode;
  if (cache && Date.now() - cache.checkedAt < PROBE_TTL_MS) return cache.mode;
  try {
    const res = await rawFetch(Routes.health, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return degradeToMock(`health ${res.status}`);
    globalMode.__oaoAdminMode = { mode: "live", checkedAt: Date.now(), warned: false };
    return "live";
  } catch (error) {
    return degradeToMock(error instanceof Error ? error.message : "unknown error");
  }
}

export async function isMockMode(): Promise<boolean> {
  return (await dataMode()) === "mock";
}

async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = adminConfig();
  const language = await currentLanguage();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Accept-Language", language === "fr" ? "fr-CH,fr;q=0.9,en;q=0.5" : "en-US,en;q=0.9");
  if (cfg.token) headers.set("Authorization", `Bearer ${cfg.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${cfg.orchestratorUrl}${path}`, { ...init, headers, cache: "no-store" });
}

/**
 * `instanceof z.ZodError` is unreliable here: the contract schemas are compiled
 * inside `@oao/shared`, which may resolve its own copy of zod.
 */
function isZodError(error: unknown): error is { issues: unknown[] } {
  return (
    error instanceof Error &&
    error.name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

export class OrchestratorError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

/**
 * Minimal parser surface. Deliberately not `z.ZodType<T>`: several contract
 * schemas use `.default()`, so their input and output types differ and the
 * stricter zod type would not accept them here.
 */
interface Parser<T> {
  parse(data: unknown): T;
}

/**
 * Calls the orchestrator and validates the payload with the shared contract.
 * `fallback` is used when the orchestrator is unusable outside production.
 */
async function call<T>(
  path: string,
  schema: Parser<T>,
  fallback: () => T | Promise<T>,
  init: RequestInit = {},
): Promise<T> {
  if ((await dataMode()) === "mock") return fallback();
  try {
    const res = await rawFetch(path, { signal: AbortSignal.timeout(20_000), ...init });
    if (!res.ok) {
      let code: string | undefined;
      let message = `${init.method ?? "GET"} ${path} → ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code;
        if (body.error?.message) message = body.error.message;
      } catch {
        /* non-JSON error body */
      }
      if (res.status >= 500) {
        degradeToMock(`${res.status}`);
        if (!adminConfig().isProduction) return fallback();
      }
      throw new OrchestratorError(message, res.status, code);
    }
    return schema.parse(await res.json());
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    if (isZodError(error)) {
      // eslint-disable-next-line no-console
      console.error(`[@oao/admin] contract mismatch on ${path}`, error.issues.slice(0, 5));
      throw new OrchestratorError(`Invalid response from ${path}`, 502, "contract_mismatch");
    }
    degradeToMock(error instanceof Error ? error.message : "unknown error");
    if (!adminConfig().isProduction) return fallback();
    throw new OrchestratorError(
      error instanceof Error ? error.message : `Failed to call ${path}`,
      503,
      "orchestrator_unavailable",
    );
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== "all") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* --------------------------------------------------------------------------- */
/*  Reads                                                                      */
/* --------------------------------------------------------------------------- */

export { DEFAULT_PERIOD } from "./query";

export async function getAuditPage(query: Partial<AuditQuery>): Promise<AuditPage> {
  return call(
    `${Routes.audit}${qs({
      from: query.from,
      to: query.to,
      userId: query.userId,
      type: query.type,
      riskLevel: query.riskLevel,
      approvalStatus: query.approvalStatus,
      search: query.search,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 25,
    })}`,
    AuditPageSchema,
    () => mockAuditPage(query),
  );
}

/** Unpaginated read used by the CSV export (capped to keep the file sane). */
export async function getAuditEventsForExport(
  query: Partial<AuditQuery>,
  limit = 2000,
): Promise<AuditEvent[]> {
  if ((await dataMode()) === "mock") return filterEvents(query).slice(0, limit);
  const pageSize = 200;
  const out: AuditEvent[] = [];
  for (let page = 1; out.length < limit; page += 1) {
    const chunk = await getAuditPage({ ...query, page, pageSize });
    out.push(...chunk.items);
    if (chunk.items.length < pageSize || out.length >= chunk.total) break;
  }
  return out.slice(0, limit);
}

export async function getAuditEvent(id: string): Promise<AuditEvent | undefined> {
  if ((await dataMode()) === "mock") return store().events.find((e) => e.id === id);
  return call(Routes.auditEvent(id), AuditEventSchema, () =>
    store().events.find((e) => e.id === id) as AuditEvent,
  );
}

export async function getAuditStats(period?: { from: string; to: string }): Promise<AuditStats> {
  return call(
    `${Routes.auditStats}${qs({ from: period?.from, to: period?.to })}`,
    AuditStatsSchema,
    () => buildStats(period ?? MOCK_PERIOD),
  );
}

export async function getAutomations(): Promise<Automation[]> {
  return call(Routes.automations, z.array(AutomationSchema), () => store().automations);
}

export async function getEscalations(): Promise<Escalation[]> {
  return call(Routes.escalations, z.array(EscalationSchema), () => store().escalations);
}

export async function getPolicy(): Promise<Policy> {
  return call(Routes.adminPolicy, PolicySchema, () => store().policy);
}

export async function getUsers(): Promise<AdminUser[]> {
  return call(Routes.adminUsers, AdminUsersResponseSchema, () => store().users);
}

export async function getFeatures(): Promise<FeatureFlags> {
  return call(Routes.features, FeatureFlagsSchema, () => mockFeatures());
}

export async function getHealth(): Promise<Health> {
  return call(Routes.health, HealthSchema, () => mockHealth());
}

/* --------------------------------------------------------------------------- */
/*  Mutations (called from the route handlers under src/app/api/*)             */
/* --------------------------------------------------------------------------- */

export type Decision = "approve" | "reject";

export async function decideEscalation(
  id: string,
  decision: Decision,
  comment?: string,
): Promise<Escalation> {
  if ((await dataMode()) === "mock") {
    const s = store();
    const target = s.escalations.find((e) => e.id === id);
    if (!target) throw new OrchestratorError(`Escalation ${id} not found`, 404, "not_found");
    target.status = decision === "approve" ? "approved" : "rejected";
    target.decidedBy = "Jane Smith";
    target.decidedAt = new Date().toISOString();
    if (comment) target.decisionComment = comment;
    return target;
  }
  return call(
    Routes.escalationDecision(id),
    EscalationSchema,
    () => store().escalations.find((e) => e.id === id) as Escalation,
    { method: "POST", body: JSON.stringify({ decision, comment }) },
  );
}

export type AutomationAction = "approve" | "reject" | "pause";

export async function decideAutomation(
  id: string,
  action: AutomationAction,
  comment?: string,
): Promise<Automation> {
  if ((await dataMode()) === "mock") {
    const s = store();
    const target = s.automations.find((a) => a.id === id);
    if (!target) throw new OrchestratorError(`Automation ${id} not found`, 404, "not_found");
    target.status = action === "approve" ? "active" : action === "reject" ? "rejected" : "paused";
    target.updatedAt = new Date().toISOString();
    return target;
  }
  if (action === "pause") {
    // The contract has no pause route; PATCH the automation with the new status.
    return call(
      Routes.automation(id),
      AutomationSchema,
      () => store().automations.find((a) => a.id === id) as Automation,
      { method: "PATCH", body: JSON.stringify({ status: "paused", comment }) },
    );
  }
  const path = action === "approve" ? Routes.automationApprove(id) : Routes.automationReject(id);
  return call(
    path,
    AutomationSchema,
    () => store().automations.find((a) => a.id === id) as Automation,
    { method: "POST", body: JSON.stringify({ comment }) },
  );
}

export async function savePolicy(policy: Policy): Promise<Policy> {
  if ((await dataMode()) === "mock") {
    const s = store();
    s.policy = {
      ...policy,
      updatedAt: new Date().toISOString(),
      updatedBy: "jane.smith@longbow.ch",
    };
    return s.policy;
  }
  return call(Routes.adminPolicy, PolicySchema, () => store().policy, {
    method: "PUT",
    body: JSON.stringify(policy),
  });
}

/* --------------------------------------------------------------------------- */
/*  Compliance alerts (derived view used by /alerts)                           */
/* --------------------------------------------------------------------------- */

const ALERT_TYPES = ["compliance_alert", "compliance_escalated", "phishing_check"] as const;

/**
 * The contract has no dedicated "alerts" endpoint, so the page is derived from
 * the audit trail: compliance alerts, escalations, and phishing checks whose
 * verdict is not `clean`.
 */
export async function getComplianceAlerts(query: Partial<AuditQuery>): Promise<AuditEvent[]> {
  const pages = await Promise.all(
    ALERT_TYPES.map((type) => getAuditPage({ ...query, type, page: 1, pageSize: 200 })),
  );
  const events = pages.flatMap((p) => p.items);
  return events
    .filter((e) => {
      if (e.type !== "phishing_check") return true;
      const verdict = e.details?.verdict;
      return verdict !== "clean";
    })
    .filter((e) => (query.riskLevel ? e.riskLevel === query.riskLevel : true))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Category label of an alert event, from `details.category` with a fallback. */
export function alertCategory(event: AuditEvent): string {
  const raw = event.details?.category;
  if (typeof raw === "string" && raw.length > 0) {
    return raw
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  if (event.type === "phishing_check") return "Phishing";
  if (event.type === "compliance_escalated") return "Escalated";
  return "Other";
}

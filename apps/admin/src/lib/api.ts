/**
 * Server-side data access for the admin dashboard.
 *
 * Every helper here runs on the server only (Server Components, server actions
 * and route handlers) so that no bearer token ever reaches the browser.
 *
 * Each outbound call carries
 *  - `Authorization: Bearer <token>` — the signed-in operator's **Entra ID
 *    access token** for the orchestrator API app in `ADMIN_AUTH_MODE=aad`, or
 *    the shared `ADMIN_API_TOKEN` in `token` mode (plus the `x-user-email` /
 *    `x-user-name` development headers),
 *  - `Accept-Language` derived from the UI language,
 *  - `x-correlation-id`, echoed back in `ApiError.correlationId` and surfaced in
 *    the error toasts.
 *
 * Two data sources:
 *  - `ADMIN_MOCK=true`  → the deterministic dataset in `./mock-data`.
 *  - otherwise          → the orchestrator at `ORCHESTRATOR_URL`; outside
 *    production a failed call logs a warning and degrades to the mock dataset so
 *    the dashboard is always demoable.
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
  MailboxSyncStatusSchema,
  PolicySchema,
  Routes,
  SystemStatusSchema,
  type AuditEvent,
  type AuditPage,
  type AuditQuery,
  type AuditStats,
  type Automation,
  type Escalation,
  type FeatureFlags,
  type Health,
  type Language,
  type MailboxSyncStatus,
  type Policy,
  type SystemStatus,
} from "@oao/shared";
import { z } from "zod";
import { env } from "@/env";
import { LANGUAGE_COOKIE, isLanguage } from "./i18n";
import type { AuditQueryLike } from "./query";
import { getAdminSession, type AdminSession } from "./session";
import { AdminUsersResponseSchema, type AdminUser, type DataMode } from "./types";
import {
  MOCK_PERIOD,
  buildStats,
  filterEvents,
  mockAuditPage,
  mockFeatures,
  mockHealth,
  automationOwner,
  mockSyncStatus,
  mockSystemStatus,
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
  timeZone: string;
  authMode: "aad" | "token";
  isProduction: boolean;
}

export function adminConfig(): AdminConfig {
  const e = env();
  return {
    orchestratorUrl: e.ORCHESTRATOR_URL,
    token: e.ADMIN_API_TOKEN ?? "",
    forceMock: e.ADMIN_MOCK,
    tenantName: e.ADMIN_TENANT_NAME,
    defaultLanguage: e.ADMIN_DEFAULT_LANGUAGE,
    timeZone: e.ADMIN_TZ,
    authMode: e.ADMIN_AUTH_MODE,
    isProduction: e.isProduction,
  };
}

export async function currentLanguage(): Promise<Language> {
  try {
    const jar = await cookies();
    const value = jar.get(LANGUAGE_COOKIE)?.value;
    if (isLanguage(value)) return value;
  } catch {
    /* outside a request scope (e.g. during the orchestrator probe) */
  }
  return adminConfig().defaultLanguage;
}

/**
 * Organisation label: the orchestrator's `FeatureFlags.organizationName` is
 * authoritative, `ADMIN_TENANT_NAME` is the fallback.
 */
export async function organizationName(): Promise<string> {
  try {
    const features = await getFeatures();
    if (features.organizationName && features.organizationName.trim().length > 0) {
      return features.organizationName;
    }
  } catch {
    /* fall through to the env label */
  }
  return adminConfig().tenantName;
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

export function newCorrelationId(): string {
  try {
    return `adm-${crypto.randomUUID()}`;
  } catch {
    return `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

async function sessionOrNull(): Promise<AdminSession | null> {
  try {
    return await getAdminSession();
  } catch {
    return null;
  }
}

export function acceptLanguage(language: Language): string {
  return language === "fr" ? "fr-CH,fr;q=0.9,en;q=0.5" : "en-US,en;q=0.9";
}

interface FetchInit extends RequestInit {
  correlationId?: string;
}

/** Builds the outbound request: bearer, locale and correlation id. */
export async function rawFetch(path: string, init: FetchInit = {}): Promise<Response> {
  const cfg = adminConfig();
  const language = await currentLanguage();
  const session = await sessionOrNull();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Accept-Language", acceptLanguage(language));
  headers.set("x-correlation-id", init.correlationId ?? newCorrelationId());

  const bearer = session?.bearer ?? cfg.token;
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  // Development headers understood by the orchestrator in AUTH_MODE=dev.
  if (session && session.mode === "token") {
    headers.set("x-user-email", session.email);
    headers.set("x-user-name", session.name);
  }
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
    readonly correlationId?: string,
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
  init: FetchInit = {},
): Promise<T> {
  if ((await dataMode()) === "mock") return fallback();
  const correlationId = init.correlationId ?? newCorrelationId();
  try {
    const res = await rawFetch(path, { signal: AbortSignal.timeout(20_000), ...init, correlationId });
    if (!res.ok) {
      let code: string | undefined;
      let serverCorrelationId: string | undefined;
      let message = `${init.method ?? "GET"} ${path} → ${res.status}`;
      try {
        const body = (await res.json()) as {
          error?: { code?: string; message?: string; correlationId?: string };
        };
        code = body.error?.code;
        serverCorrelationId = body.error?.correlationId;
        if (body.error?.message) message = body.error.message;
      } catch {
        /* non-JSON error body */
      }
      if (res.status >= 500) {
        degradeToMock(`${res.status}`);
        if (!adminConfig().isProduction) return fallback();
      }
      throw new OrchestratorError(
        message,
        res.status,
        code,
        serverCorrelationId ?? res.headers.get("x-correlation-id") ?? correlationId,
      );
    }
    return schema.parse(await res.json());
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    if (isZodError(error)) {
      console.error(`[@oao/admin] contract mismatch on ${path}`, error.issues.slice(0, 5));
      throw new OrchestratorError(
        `Invalid response from ${path}`,
        502,
        "contract_mismatch",
        correlationId,
      );
    }
    degradeToMock(error instanceof Error ? error.message : "unknown error");
    if (!adminConfig().isProduction) return fallback();
    throw new OrchestratorError(
      error instanceof Error ? error.message : `Failed to call ${path}`,
      503,
      "orchestrator_unavailable",
      correlationId,
    );
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "" && v !== "all") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function auditQueryString(query: AuditQueryLike): string {
  return qs({
    from: query.from,
    to: query.to,
    userId: query.userId,
    type: query.type,
    riskLevel: query.riskLevel,
    approvalStatus: query.approvalStatus,
    search: query.search,
    // Not in `AuditQuery` yet (see the contract requests in the README); an
    // orchestrator that ignores them simply returns the unfiltered page.
    source: query.source,
    model: query.model,
    page: query.page ?? 1,
    pageSize: query.pageSize ?? 25,
  });
}

/* --------------------------------------------------------------------------- */
/*  Reads                                                                      */
/* --------------------------------------------------------------------------- */

export { DEFAULT_PERIOD } from "./query";

export async function getAuditPage(query: AuditQueryLike): Promise<AuditPage> {
  return call(`${Routes.audit}${auditQueryString(query)}`, AuditPageSchema, () =>
    mockAuditPage(query),
  );
}

/** Unpaginated read used by the client-side CSV fallback (capped). */
export async function getAuditEventsForExport(
  query: AuditQueryLike,
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

/**
 * `Routes.auditExport` streamed straight through — the CSV is produced by the
 * orchestrator and never buffered in the dashboard. `null` means "not available"
 * (mock mode, or an orchestrator without the route), so the caller falls back to
 * building the CSV from the paginated reads.
 */
export async function streamAuditExport(
  query: AuditQueryLike,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string } | null> {
  if ((await dataMode()) === "mock") return null;
  try {
    const res = await rawFetch(`${Routes.auditExport}${auditQueryString({ ...query, page: 1, pageSize: 200 })}`, {
      headers: { Accept: "text/csv" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) return null;
    return { body: res.body, contentType: res.headers.get("content-type") ?? "text/csv; charset=utf-8" };
  } catch {
    return null;
  }
}

export async function getAuditEvent(id: string): Promise<AuditEvent | undefined> {
  if ((await dataMode()) === "mock") return store().events.find((e) => e.id === id);
  try {
    return await call(Routes.auditEvent(id), AuditEventSchema, () =>
      store().events.find((e) => e.id === id) as AuditEvent,
    );
  } catch (error) {
    if (error instanceof OrchestratorError && error.status === 404) return undefined;
    throw error;
  }
}

/** Sibling events of the same correlation id (deep-link context on `/audit/[id]`). */
export async function getRelatedAuditEvents(
  event: AuditEvent,
  limit = 10,
): Promise<AuditEvent[]> {
  if (!event.correlationId) return [];
  if ((await dataMode()) === "mock") {
    return store()
      .events.filter((e) => e.correlationId === event.correlationId && e.id !== event.id)
      .slice(0, limit);
  }
  const page = await getAuditPage({ search: event.correlationId, page: 1, pageSize: limit + 1 });
  return page.items.filter((e) => e.id !== event.id).slice(0, limit);
}

export async function getAuditStats(period?: { from: string; to: string }): Promise<AuditStats> {
  return call(
    `${Routes.auditStats}${qs({ from: period?.from, to: period?.to })}`,
    AuditStatsSchema,
    () => buildStats(period ?? MOCK_PERIOD),
  );
}

/**
 * `Automation` carries no owner in the contract, so the per-user filter is sent
 * to the orchestrator as `?userId=` (`?all=true` for the global admin view) and
 * only narrowed locally in mock mode, where `automationOwner()` knows who
 * triggered each detected routine. See the contract request in the README.
 */
export async function getAutomations(options: { all?: boolean; userId?: string } = {}): Promise<
  Automation[]
> {
  const path = `${Routes.automations}${qs({
    all: options.all ? true : undefined,
    userId: options.userId,
  })}`;
  const automations = await call(path, z.array(AutomationSchema), () => {
    const all = store().automations;
    if (!options.userId) return all;
    return all.filter((a) => automationOwner(a.id) === options.userId);
  });
  return automations;
}

export async function getEscalations(): Promise<Escalation[]> {
  return call(Routes.escalations, z.array(EscalationSchema), () => store().escalations);
}

export async function getPendingEscalationCount(): Promise<number> {
  try {
    return (await getEscalations()).filter((e) => e.status === "pending").length;
  } catch {
    return 0;
  }
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

/** `/system`: queues, caches, workers, mailbox sync. */
export async function getSystemStatus(): Promise<SystemStatus> {
  return call(Routes.adminSystem, SystemStatusSchema, () => mockSystemStatus());
}

export async function getMailboxSyncStatus(): Promise<MailboxSyncStatus> {
  return call(Routes.mailboxSync, MailboxSyncStatusSchema, () => mockSyncStatus());
}

/* --------------------------------------------------------------------------- */
/*  Mutations (called from the route handlers / server actions)                */
/* --------------------------------------------------------------------------- */

export type Decision = "approve" | "reject";

export async function decideEscalation(
  id: string,
  decision: Decision,
  comment: string | undefined,
  decidedBy: string,
): Promise<Escalation> {
  if ((await dataMode()) === "mock") {
    const s = store();
    const target = s.escalations.find((e) => e.id === id);
    if (!target) throw new OrchestratorError(`Escalation ${id} not found`, 404, "not_found");
    target.status = decision === "approve" ? "approved" : "rejected";
    target.decidedBy = decidedBy;
    target.decidedAt = new Date().toISOString();
    if (comment) target.decisionComment = comment;
    return target;
  }
  return call(
    Routes.escalationDecision(id),
    EscalationSchema,
    () => store().escalations.find((e) => e.id === id) as Escalation,
    {
      method: "POST",
      body: JSON.stringify({
        decision: decision === "approve" ? "approved" : "rejected",
        comment,
      }),
    },
  );
}

export type AutomationAction = "approve" | "reject" | "pause" | "resume";

/** Status written by a `pause` / `resume` (PATCH `{ status }`). */
export function automationStatusFor(action: AutomationAction): Automation["status"] {
  switch (action) {
    case "approve":
      return "active";
    case "reject":
      return "rejected";
    case "pause":
      return "paused";
    case "resume":
      return "active";
  }
}

export async function decideAutomation(
  id: string,
  action: AutomationAction,
  comment?: string,
): Promise<Automation> {
  if ((await dataMode()) === "mock") {
    const s = store();
    const target = s.automations.find((a) => a.id === id);
    if (!target) throw new OrchestratorError(`Automation ${id} not found`, 404, "not_found");
    target.status = automationStatusFor(action);
    target.updatedAt = new Date().toISOString();
    return target;
  }
  if (action === "pause" || action === "resume") {
    // The contract has no pause/resume route; PATCH the automation status.
    return call(
      Routes.automation(id),
      AutomationSchema,
      () => store().automations.find((a) => a.id === id) as Automation,
      { method: "PATCH", body: JSON.stringify({ status: automationStatusFor(action), comment }) },
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

export async function savePolicy(policy: Policy, updatedBy: string): Promise<Policy> {
  const payload: Policy = { ...policy, updatedAt: new Date().toISOString(), updatedBy };
  if ((await dataMode()) === "mock") {
    const s = store();
    s.policy = payload;
    return s.policy;
  }
  return call(Routes.adminPolicy, PolicySchema, () => store().policy, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

/** "Sync now" on `/system`. */
export async function triggerMailboxSync(): Promise<MailboxSyncStatus> {
  if ((await dataMode()) === "mock") {
    const s = store();
    s.sync = {
      ...s.sync,
      state: s.sync.enabled ? "syncing" : "disabled",
      lastSyncAt: new Date().toISOString(),
      pending: s.sync.enabled ? Math.max(0, s.sync.pending - 1) : s.sync.pending,
    };
    return s.sync;
  }
  return call(Routes.mailboxSync, MailboxSyncStatusSchema, () => store().sync, {
    method: "POST",
    body: JSON.stringify({ refresh: true }),
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
export async function getComplianceAlerts(query: AuditQueryLike): Promise<AuditEvent[]> {
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

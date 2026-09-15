/**
 * Typed fetch wrapper over the shared `Routes` table.
 *
 *  - base URL from VITE_API_BASE_URL (default http://localhost:8080 in dev,
 *    https://localhost:8443 otherwise)
 *  - auth header injection (dev headers or SSO bearer, see office/sso.ts)
 *  - per-call timeout (short for GETs, long for model calls)
 *  - retry with exponential backoff + jitter, **only** for idempotent GETs and
 *    only for network / timeout / 429 / 5xx — a POST is never replayed, because
 *    replaying `analyze/email` would cost a second model call
 *  - `x-correlation-id` on every request so a user-visible error can be matched
 *    to a backend log line; the id is surfaced in the error boundary "Report"
 *  - connectivity reporting (net/connectivity) → offline banner
 *  - `Accept-Language`, zod parsing with the shared schemas, ApiError mapping
 *  - 404 on `analysisByEmail` resolves to `null` instead of throwing
 */
import {
  ActionProposalSchema,
  ApiErrorSchema,
  ApproveActionsResponseSchema,
  AutomationSchema,
  ChatResponseSchema,
  ComplianceCheckResponseSchema,
  DailyBriefSchema,
  DraftReplySchema,
  EmailAnalysisSchema,
  EscalationSchema,
  FeatureFlagsSchema,
  HealthSchema,
  IndexEmailsResponseSchema,
  MailboxSyncStatusSchema,
  Routes,
  ThreadSynthesisSchema,
  type Language,
} from "@oao/shared";
import { z, type ZodType } from "zod";
import { ApiClientError, kindFromStatus } from "./errors";
import type { OaoApi } from "./types";
import { getAuthHeaders, invalidateToken } from "@/office/sso";
import { browserOnline, reportNetworkFailure, reportReachable } from "@/net/connectivity";
import { track } from "@/telemetry";

/** Model calls: generous. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Reads that must feel instant (precomputed analysis, brief, sync, features). */
export const FAST_TIMEOUT_MS = 8_000;
/** Health check: must never delay the first paint. */
export const HEALTH_TIMEOUT_MS = 4_000;

export const MAX_GET_ATTEMPTS = 3;

export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return import.meta.env.DEV ? "http://localhost:8080" : "https://localhost:8443";
}

const AutomationListSchema = z.union([z.array(AutomationSchema), z.object({ items: z.array(AutomationSchema) })]);

export function parseResponse<T>(schema: ZodType<T, z.ZodTypeDef, unknown>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  if (import.meta.env.DEV) {
    console.error(`[oao] response for ${label} does not match the shared schema`, result.error.issues, data);
  }
  track("api.schema_mismatch", { feature: label.split("/").pop() }, { severity: "warning" });
  // Be lenient at runtime: return the raw payload so the UI can still render what it can.
  return data as T;
}

/** RFC 4122-ish id without pulling in a uuid dependency. */
export function newCorrelationId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    if (c?.getRandomValues) {
      const bytes = c.getRandomValues(new Uint8Array(16));
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Only these are safe to replay. */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiClientError)) return false;
  if (err.kind === "network" || err.kind === "timeout") return true;
  if (err.status === 429) return true;
  return typeof err.status === "number" && err.status >= 500;
}

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  // 250 ms, 700 ms (± 40 % jitter), capped at 4 s.
  const base = Math.min(4_000, 250 * 2.8 ** (attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LiveClientOptions {
  baseUrl?: string;
  getLanguage: () => Language;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam: skip the real backoff waits. */
  delayImpl?: (ms: number) => Promise<void>;
}

export function createLiveClient(options: LiveClientOptions): OaoApi {
  const base = options.baseUrl ?? apiBaseUrl();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const delay = options.delayImpl ?? sleep;

  interface RequestOptions {
    timeoutMs?: number;
    auth?: boolean;
    /** Resolve to null instead of throwing when the backend answers 404. */
    nullOn404?: boolean;
    /** Override the retry policy (GETs retry by default). */
    attempts?: number;
  }

  async function once<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: ZodType<T, z.ZodTypeDef, unknown> | null,
    opts: RequestOptions,
    correlationId: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Language": options.getLanguage(),
      "x-correlation-id": correlationId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      try {
        Object.assign(headers, await getAuthHeaders());
      } catch (err) {
        clearTimeout(timer);
        throw ApiClientError.fromAuthFailure(err, correlationId);
      }
    }
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      });
    } catch (err) {
      clearTimeout(timer);
      reportNetworkFailure();
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new ApiClientError("timeout", "Request timed out", undefined, undefined, correlationId);
      }
      throw new ApiClientError("network", err instanceof Error ? err.message : "Network error", undefined, undefined, correlationId);
    }
    clearTimeout(timer);
    reportReachable();

    const text = await res.text().catch(() => "");
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      if (res.status === 404 && opts.nullOn404) return null as T;
      if (res.status === 401) invalidateToken();
      const parsed = ApiErrorSchema.safeParse(json);
      const code = parsed.success ? parsed.data.error.code : undefined;
      const message = parsed.success ? parsed.data.error.message : `${res.status} ${res.statusText}`;
      const serverCorrelation = parsed.success ? parsed.data.error.correlationId : undefined;
      throw new ApiClientError(kindFromStatus(res.status, code), message, res.status, code, serverCorrelation ?? correlationId);
    }
    if (!schema) return undefined as T;
    if (json === undefined && opts.nullOn404) return null as T;
    return parseResponse(schema, json, path);
  }

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: ZodType<T, z.ZodTypeDef, unknown> | null,
    opts: RequestOptions = {},
  ): Promise<T> {
    const correlationId = newCorrelationId();
    const attempts = opts.attempts ?? (method === "GET" ? MAX_GET_ATTEMPTS : 1);
    const started = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Fail fast while the device is offline rather than burning the timeout.
      if (!browserOnline()) {
        lastError = new ApiClientError("network", "Offline", undefined, "offline", correlationId);
        break;
      }
      try {
        const value = await once<T>(method, path, body, schema, opts, correlationId);
        track("api.request", { mode: method, feature: path, ms: Date.now() - started, attempt, status: "ok" }, { correlationId });
        return value;
      } catch (err) {
        lastError = err;
        if (attempt >= attempts || !isRetryable(err)) break;
        await delay(backoffDelayMs(attempt));
      }
    }
    const kind = lastError instanceof ApiClientError ? lastError.kind : "generic";
    track(
      "api.request",
      { mode: method, feature: path, ms: Date.now() - started, status: "error", errorKind: kind },
      { severity: "warning", correlationId: lastError instanceof ApiClientError ? lastError.correlationId : correlationId },
    );
    throw lastError;
  }

  /** Nullable GET (used for 404-as-absent routes). */
  function getOrNull<T>(path: string, schema: ZodType<T, z.ZodTypeDef, unknown>, timeout = FAST_TIMEOUT_MS): Promise<T | null> {
    return request<T | null>("GET", path, undefined, schema.nullable(), { timeoutMs: timeout, nullOn404: true });
  }

  return {
    mode: "live",
    health: () => request("GET", Routes.health, undefined, HealthSchema, { timeoutMs: HEALTH_TIMEOUT_MS, auth: false, attempts: 1 }),
    features: () => request("GET", Routes.features, undefined, FeatureFlagsSchema, { timeoutMs: FAST_TIMEOUT_MS }),
    analysisByEmail: (emailId) => getOrNull(Routes.analysisByEmail(emailId), EmailAnalysisSchema),
    analyzeEmail: (req) => request("POST", Routes.analyzeEmail, req, EmailAnalysisSchema),
    analyzeThread: (req) => request("POST", Routes.analyzeThread, req, ThreadSynthesisSchema),
    draftReply: (req) => request("POST", Routes.draftReply, req, DraftReplySchema),
    chat: (req) => request("POST", Routes.chat, req, ChatResponseSchema),
    indexEmails: (req) => request("POST", Routes.indexEmails, req, IndexEmailsResponseSchema),
    proposeActions: (req) => request("POST", Routes.proposeActions, req, ActionProposalSchema),
    approveActions: (req) => request("POST", Routes.approveActions, req, ApproveActionsResponseSchema),
    reportActionResult: (id, req) => request("POST", Routes.reportActionResult(id), req, null),
    complianceCheck: (req) => request("POST", Routes.complianceCheck, req, ComplianceCheckResponseSchema),
    createEscalation: (req) => request("POST", Routes.escalations, req, EscalationSchema),
    observe: (event) => request("POST", Routes.automationsObserve, { events: [event] }, null, { timeoutMs: 10_000 }),
    listAutomations: async () => {
      const data = await request("GET", Routes.automations, undefined, AutomationListSchema, { timeoutMs: FAST_TIMEOUT_MS });
      return Array.isArray(data) ? data : data.items;
    },
    detectAutomations: async () => {
      const data = await request("POST", Routes.automationDetect, {}, AutomationListSchema);
      return Array.isArray(data) ? data : data.items;
    },
    simulateAutomation: (id, req) => request("POST", Routes.automationSimulate(id), req, AutomationSchema),
    approveAutomation: (id, req) => request("POST", Routes.automationApprove(id), req, AutomationSchema),
    rejectAutomation: (id, req) => request("POST", Routes.automationReject(id), req, AutomationSchema),
    feedback: (req) => request("POST", Routes.feedback, req, null),
    dailyBrief: (req) => {
      const query = new URLSearchParams();
      if (req?.date) query.set("date", req.date);
      if (req?.language) query.set("language", req.language);
      const qs = query.toString();
      return getOrNull(`${Routes.dailyBrief}${qs ? `?${qs}` : ""}`, DailyBriefSchema);
    },
    generateDailyBrief: (req) => request("POST", Routes.dailyBrief, { ...req, refresh: true }, DailyBriefSchema),
    mailboxSync: () => request("GET", Routes.mailboxSync, undefined, MailboxSyncStatusSchema, { timeoutMs: FAST_TIMEOUT_MS }),
    syncNow: () => request("POST", Routes.mailboxSync, {}, MailboxSyncStatusSchema, { timeoutMs: 20_000 }),
  };
}

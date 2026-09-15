/**
 * Typed fetch wrapper over the shared `Routes` table.
 *  - base URL from VITE_API_BASE_URL (default http://localhost:8080 in dev, https://localhost:8443 otherwise)
 *  - auth header injection (dev headers or SSO bearer, see office/sso.ts)
 *  - Accept-Language, 60 s timeout, ApiError → ApiClientError mapping
 *  - every response is zod-parsed with the shared schemas (dev: console.error on mismatch)
 */
import {
  ActionProposalSchema,
  ApiErrorSchema,
  ApproveActionsResponseSchema,
  AutomationSchema,
  ChatResponseSchema,
  ComplianceCheckResponseSchema,
  DraftReplySchema,
  EmailAnalysisSchema,
  EscalationSchema,
  HealthSchema,
  IndexEmailsResponseSchema,
  Routes,
  ThreadSynthesisSchema,
  type Language,
} from "@oao/shared";
import { z, type ZodType } from "zod";
import { ApiClientError, kindFromStatus } from "./errors";
import type { OaoApi } from "./types";
import { getAuthHeaders, invalidateToken } from "@/office/sso";

export const DEFAULT_TIMEOUT_MS = 60_000;

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
  // Be lenient at runtime: return the raw payload so the UI can still render what it can.
  return data as T;
}

export interface LiveClientOptions {
  baseUrl?: string;
  getLanguage: () => Language;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createLiveClient(options: LiveClientOptions): OaoApi {
  const base = options.baseUrl ?? apiBaseUrl();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function request<T>(method: "GET" | "POST", path: string, body: unknown, schema: ZodType<T, z.ZodTypeDef, unknown> | null, opts?: { timeoutMs?: number; auth?: boolean }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? timeoutMs);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Language": options.getLanguage(),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.auth !== false) {
      try {
        Object.assign(headers, await getAuthHeaders());
      } catch (err) {
        clearTimeout(timer);
        throw new ApiClientError("unauthorized", err instanceof Error ? err.message : "SSO failed");
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
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === "AbortError") throw new ApiClientError("timeout", "Request timed out");
      throw new ApiClientError("network", err instanceof Error ? err.message : "Network error");
    }
    clearTimeout(timer);

    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      if (res.status === 401) invalidateToken();
      const parsed = ApiErrorSchema.safeParse(json);
      const code = parsed.success ? parsed.data.error.code : undefined;
      const message = parsed.success ? parsed.data.error.message : `${res.status} ${res.statusText}`;
      throw new ApiClientError(kindFromStatus(res.status, code), message, res.status, code, parsed.success ? parsed.data.error.correlationId : undefined);
    }
    if (!schema) return undefined as T;
    return parseResponse(schema, json, path);
  }

  return {
    mode: "live",
    health: () => request("GET", Routes.health, undefined, HealthSchema, { timeoutMs: 4000, auth: false }),
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
      const data = await request("GET", Routes.automations, undefined, AutomationListSchema);
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
  };
}

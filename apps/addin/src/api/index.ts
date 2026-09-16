import type { Language } from "@oao/shared";
import { apiBaseUrl, createLiveClient } from "./client";
import { createMockClient } from "./mock";
import type { OaoApi } from "./types";

export * from "./types";
export * from "./errors";
export { apiBaseUrl } from "./client";

let current: OaoApi | null = null;
let languageGetter: () => Language = () => "en";

export function setLanguageGetter(fn: () => Language): void {
  languageGetter = fn;
}

/** Current API implementation (mock by default until `initApi` ran). */
export function getApi(): OaoApi {
  if (!current) current = createMockClient(() => languageGetter());
  return current;
}

export function isMockRequested(): boolean {
  if (import.meta.env.VITE_API_MOCK === "true") return true;
  try {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  } catch {
    return false;
  }
}

/** Why the pane is talking to the mock / the live backend. */
export type ApiDecisionReason = "requested" | "preview-fallback" | "live" | "live-unreachable";

export interface ApiDecision {
  api: "live" | "mock";
  reason: ApiDecisionReason;
  /** True when the pane must block with an explanation instead of rendering. */
  blocking: boolean;
}

export interface ApiDecisionInput {
  /** `VITE_API_MOCK=true` or `?mock=1`. */
  mockRequested: boolean;
  /**
   * Browser **preview** mode — no Outlook host at all (see `isPreviewMode()`).
   * The tab / home surface is *not* preview: it has no mailbox but a real user.
   */
  preview: boolean;
  /** Did the startup health check succeed? */
  healthOk: boolean;
}

/**
 * live vs mock, as a pure function — this is the decision that used to be
 * "any dev build falls back to the mock".
 *
 * That rule was actively harmful: inside a real Outlook host a dev build whose
 * `VITE_API_BASE_URL` pointed nowhere silently switched to the mock client, and
 * the pane then drafted a reply from the **built-in sample email** instead of
 * the message the user was actually reading. Nothing on screen said so.
 *
 * So: the mock is used only when it was asked for, or in browser preview where
 * there is no real mailbox to misrepresent. Inside any Outlook host — read,
 * compose, pinned, multi-select or the Apps-rail home surface — the pane stays
 * on the live client and *says* the orchestrator is unreachable (blocking error
 * with a Retry button), rather than inventing data about someone's mailbox.
 */
export function decideApi({ mockRequested, preview, healthOk }: ApiDecisionInput): ApiDecision {
  if (mockRequested) return { api: "mock", reason: "requested", blocking: false };
  if (healthOk) return { api: "live", reason: "live", blocking: false };
  if (preview) return { api: "mock", reason: "preview-fallback", blocking: false };
  return { api: "live", reason: "live-unreachable", blocking: true };
}

export interface InitApiResult {
  api: OaoApi;
  decision: ApiDecision;
  /**
   * The health-check failure the pane must show (never swallowed into sample
   * data). `null` when the backend answered, or when the mock is in use on
   * purpose.
   */
  healthError: unknown | null;
  /** Backend base URL, so the error state can name it. */
  baseUrl: string;
}

/**
 * Choose the API implementation and report what happened.
 *  - `VITE_API_MOCK=true` / `?mock=1` → mock, no health check at all
 *  - health check OK → live
 *  - health check fails **in browser preview** → mock, so the UI stays reviewable
 *  - health check fails **inside Outlook** → live + `healthError` (blocking)
 */
export async function initApi(opts: { preview: boolean }): Promise<InitApiResult> {
  const baseUrl = apiBaseUrl();
  if (isMockRequested()) {
    current = createMockClient(() => languageGetter());
    return { api: current, decision: decideApi({ mockRequested: true, preview: opts.preview, healthOk: false }), healthError: null, baseUrl };
  }
  const live = createLiveClient({ getLanguage: () => languageGetter() });
  let healthError: unknown | null = null;
  try {
    await live.health();
  } catch (err) {
    healthError = err;
  }
  const decision = decideApi({ mockRequested: false, preview: opts.preview, healthOk: healthError === null });
  if (decision.api === "mock") {
    console.warn("[oao] backend health check failed — using the mock API (browser preview only)", healthError);
    current = createMockClient(() => languageGetter());
    return { api: current, decision, healthError: null, baseUrl };
  }
  current = live;
  return { api: live, decision, healthError: decision.blocking ? healthError : null, baseUrl };
}

/** Test helper. */
export function setApi(api: OaoApi | null): void {
  current = api;
}

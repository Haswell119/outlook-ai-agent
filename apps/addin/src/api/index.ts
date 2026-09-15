import type { Language } from "@oao/shared";
import { createLiveClient } from "./client";
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

/**
 * Choose live vs mock:
 *  - VITE_API_MOCK=true or `?mock=1` → mock
 *  - otherwise health-check the backend; when it fails in a dev build or in
 *    browser-preview mode → mock (so the UI can always be reviewed)
 *  - production inside Outlook → live even when the health check fails (errors surface in the UI)
 */
export async function initApi(opts: { preview: boolean }): Promise<OaoApi> {
  if (isMockRequested()) {
    current = createMockClient(() => languageGetter());
    return current;
  }
  const live = createLiveClient({ getLanguage: () => languageGetter() });
  try {
    await live.health();
    current = live;
  } catch (err) {
    if (import.meta.env.DEV || opts.preview) {
      console.warn("[oao] backend health check failed — using the mock API", err);
      current = createMockClient(() => languageGetter());
    } else {
      current = live;
    }
  }
  return current;
}

/** Test helper. */
export function setApi(api: OaoApi | null): void {
  current = api;
}

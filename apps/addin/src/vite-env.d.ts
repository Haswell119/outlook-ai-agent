/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_API_MOCK?: string;
  readonly VITE_AUTH_MODE?: "dev" | "aad";
  readonly VITE_ADMIN_URL?: string;
  readonly VITE_COMPLIANCE_EMAIL?: string;
  /** Fetch-beacon telemetry endpoint (no-op sink when unset). */
  readonly VITE_TELEMETRY_URL?: string;
  /** Application Insights connection string (beacon to its track endpoint). */
  readonly VITE_APPINSIGHTS_CONNECTION_STRING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Stamped by vite.config.ts `define` — see app/settings.ts `buildInfo()`. */
declare const __OAO_BUILD__: { version: string; commit: string; builtAt: string };

import { createContext, useContext } from "react";
import type { FeatureFlags } from "@oao/shared";
import type { OaoApi } from "@/api";

export interface AppContextValue {
  /** No Outlook host: sample data + toasts instead of Office.js calls. */
  preview: boolean;
  api: OaoApi;
  adminUrl: string;
  complianceEmail: string;
  /**
   * `GET /config/features`, loaded once at startup. `null` while it is loading
   * or when the backend does not answer — every consumer must degrade
   * gracefully rather than block on it.
   */
  features: FeatureFlags | null;
  /** Open the settings sheet (owned by the app shell). */
  openSettings: () => void;
}

export const AppContext = createContext<AppContextValue>({
  preview: true,
  api: null as unknown as OaoApi,
  adminUrl: "",
  complianceEmail: "",
  features: null,
  openSettings: () => undefined,
});

export function useApp(): AppContextValue {
  return useContext(AppContext);
}

export function adminUrl(): string {
  return (import.meta.env.VITE_ADMIN_URL ?? "http://localhost:3001").replace(/\/+$/, "");
}

export function complianceEmail(): string {
  return import.meta.env.VITE_COMPLIANCE_EMAIL ?? "compliance@northbridge.example";
}

/**
 * Organisation display name. Comes from the backend (`ORGANIZATION_NAME`) so
 * that the UI never hard-codes a customer name; falls back to a neutral label.
 */
export function organizationLabel(features: FeatureFlags | null, fallback: string): string {
  const name = features?.organizationName?.trim();
  return name && name.length > 0 ? name : fallback;
}

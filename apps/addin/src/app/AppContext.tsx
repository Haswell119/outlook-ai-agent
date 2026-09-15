import { createContext, useContext } from "react";
import type { OaoApi } from "@/api";

export interface AppContextValue {
  /** No Outlook host: sample data + toasts instead of Office.js calls. */
  preview: boolean;
  api: OaoApi;
  adminUrl: string;
  complianceEmail: string;
}

export const AppContext = createContext<AppContextValue>({
  preview: true,
  api: null as unknown as OaoApi,
  adminUrl: "",
  complianceEmail: "",
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

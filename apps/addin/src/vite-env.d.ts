/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_API_MOCK?: string;
  readonly VITE_AUTH_MODE?: "dev" | "aad";
  readonly VITE_ADMIN_URL?: string;
  readonly VITE_COMPLIANCE_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

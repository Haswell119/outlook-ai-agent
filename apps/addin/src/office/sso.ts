/**
 * Auth headers for the orchestrator.
 *  - VITE_AUTH_MODE=dev  → x-user-email / x-user-name from Office.context.mailbox.userProfile
 *  - VITE_AUTH_MODE=aad  → Office SSO bearer token (OfficeRuntime.auth.getAccessToken);
 *                          falls back to dev headers when SSO fails and we are in a dev build.
 */
import { currentUser, isOfficeAvailable } from "./env";

export type AuthMode = "dev" | "aad";

export function authMode(): AuthMode {
  return import.meta.env.VITE_AUTH_MODE === "aad" ? "aad" : "dev";
}

let cachedToken: { value: string; expiresAt: number } | null = null;

function devHeaders(): Record<string, string> {
  const user = currentUser();
  return { "x-user-email": user.email, "x-user-name": user.name };
}

async function getSsoToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const runtime = (globalThis as { OfficeRuntime?: typeof OfficeRuntime }).OfficeRuntime;
  if (!runtime?.auth?.getAccessToken) throw new Error("OfficeRuntime.auth unavailable");
  const token = await runtime.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true, forMSGraphAccess: false });
  // Tokens last ~1h; we keep them 50 min.
  cachedToken = { value: token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}

export function invalidateToken(): void {
  cachedToken = null;
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  if (authMode() === "dev" || !isOfficeAvailable()) return devHeaders();
  try {
    const token = await getSsoToken();
    return { Authorization: `Bearer ${token}` };
  } catch (err) {
    if (import.meta.env.DEV) {
      console.warn("[oao] SSO failed, falling back to dev headers", err);
      return devHeaders();
    }
    throw err;
  }
}

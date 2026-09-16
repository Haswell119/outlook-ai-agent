/**
 * Azure AD (Microsoft Entra ID) sign-in for the admin dashboard — Auth.js v5.
 *
 * Highlights
 *  - JWT session strategy (no database), lifetime `ADMIN_SESSION_MAX_AGE`.
 *  - The `api://{ORCHESTRATOR_API_CLIENT_ID}/access_as_user` scope is requested
 *    at sign-in, so the session holds an **access token for the orchestrator**
 *    (audience = the API app registration), not just an id token.
 *  - Refresh-token rotation ~60 s before expiry; a failed refresh marks the
 *    session `RefreshAccessTokenError` so the UI asks for a new sign-in.
 *  - Roles come from the `roles` claim of the access token, with the
 *    `ADMIN_EMAILS` / `COMPLIANCE_EMAILS` fallback.
 *
 * The token plumbing itself lives in `src/lib/entra.ts` (no `next-auth` import),
 * which is where it is unit-tested.
 */
import NextAuth, { type NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { env } from "@/env";
import {
  REFRESH_SKEW_MS,
  refreshAccessToken,
  requestedScopes,
  rolesFromAccessToken,
} from "@/lib/entra";
import type { AdminRole } from "@/lib/rbac";

declare module "next-auth" {
  interface Session {
    roles: AdminRole[];
    accessToken?: string;
    accessTokenExpiresAt?: number;
    error?: "RefreshAccessTokenError";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    roles?: AdminRole[];
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: "RefreshAccessTokenError";
  }
}

export const authConfig: NextAuthConfig = {
  trustHost: true,
  session: { strategy: "jwt", maxAge: env().ADMIN_SESSION_MAX_AGE },
  pages: { signIn: "/signin", error: "/signin" },
  providers: [
    MicrosoftEntraID({
      clientId: env().AUTH_MICROSOFT_ENTRA_ID_ID ?? "unconfigured",
      clientSecret: env().AUTH_MICROSOFT_ENTRA_ID_SECRET ?? "unconfigured",
      issuer: env().AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      authorization: { params: { scope: requestedScopes() } },
      // The provider's default `profile()` fetches the photo from Graph, which
      // would need a Graph-scoped token we deliberately do not request.
      profile: (profile) => ({
        id: profile.sub ?? profile.oid,
        name: profile.name,
        email: profile.email ?? profile.preferred_username ?? profile.upn,
      }),
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt =
          typeof account.expires_at === "number"
            ? account.expires_at * 1000
            : Date.now() + 3_300_000;
        token.roles = rolesFromAccessToken(account.access_token, token.email);
        delete token.error;
        return token;
      }
      if (token.expiresAt && Date.now() < token.expiresAt - REFRESH_SKEW_MS) return token;
      return refreshAccessToken(token);
    },
    async session({ session, token }) {
      session.roles = token.roles ?? ["user"];
      session.accessToken = token.accessToken;
      session.accessTokenExpiresAt = token.expiresAt;
      if (token.error) session.error = token.error;
      if (session.user) {
        session.user.email = (token.email as string | undefined) ?? session.user.email;
        session.user.name = (token.name as string | undefined) ?? session.user.name;
      }
      return session;
    },
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig);

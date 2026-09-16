/**
 * Every page and every `/api/*` route handler goes through here.
 *
 *  - `aad` mode: the Auth.js JWT cookie is decrypted (edge-safe `getToken`) and
 *    the role table in `lib/rbac` decides. No session → `/signin?callbackUrl=…`;
 *    a session without a dashboard role → `/no-access`; a compliance officer on
 *    an admin-only page → their landing page.
 *  - `token` mode: the development identity (`ADMIN_DEV_ROLES`) is applied with
 *    exactly the same role table, so RBAC is testable without Entra ID.
 *
 * The middleware is the first line of defence only: every server action and
 * route handler re-checks the role with `requireRoles()`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { env } from "@/env";
import {
  canAccess,
  isPublicPath,
  landingPath,
  rolesFromClaims,
  type AdminRole,
} from "@/lib/rbac";
import { buildContentSecurityPolicy, createNonce } from "@/lib/security";

/** Paths the middleware never touches (Auth.js endpoints, health, assets). */
const BYPASS = ["/api/auth", "/api/ping", "/_next", "/favicon.ico", "/icon.svg"];

const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

/**
 * Emits the CSP with a fresh nonce and forwards it on the *request* headers so
 * the App Router stamps the same nonce on its inline bootstrap scripts.
 */
function withCsp(request: NextRequest, response?: NextResponse): NextResponse {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV !== "production",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const res = response ?? NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("content-security-policy", csp);
  return res;
}

function unauthorized(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "unauthorized", message: "Sign-in required" } },
      { status: 401 },
    );
  }
  const url = request.nextUrl.clone();
  url.pathname = "/signin";
  url.search = "";
  url.searchParams.set(
    "callbackUrl",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(url);
}

function forbidden(request: NextRequest, roles: AdminRole[]): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Insufficient role" } },
      { status: 403 },
    );
  }
  const url = request.nextUrl.clone();
  url.search = "";
  url.pathname = landingPath(roles);
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (BYPASS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const guard = (response: NextResponse) =>
    response.status >= 300 && response.status < 400 ? response : withCsp(request, response);

  const e = env();
  let roles: AdminRole[];

  if (e.ADMIN_AUTH_MODE === "token") {
    // `ADMIN_AUTH_MODE=token` grants `ADMIN_DEV_ROLES` with no credential at
    // all. In production that is an unauthenticated admin dashboard, so the
    // request is refused outright rather than silently signed in.
    if (e.insecureAuthMode) return guard(unauthorized(request));
    roles = rolesFromClaims({
      roles: e.ADMIN_DEV_ROLES,
      email: e.ADMIN_DEV_EMAIL,
      adminEmails: e.ADMIN_EMAILS,
      complianceEmails: e.COMPLIANCE_EMAILS,
    });
  } else {
    const cookieName = SESSION_COOKIES.find((name) => request.cookies.has(name));
    const token = cookieName
      ? await getToken({
          req: request,
          secret: e.AUTH_SECRET,
          cookieName,
          secureCookie: cookieName.startsWith("__Secure-"),
        })
      : null;
    if (!token) return isPublicPath(pathname) ? withCsp(request) : guard(unauthorized(request));
    roles = (token.roles as AdminRole[] | undefined) ?? ["user"];
  }

  if (isPublicPath(pathname)) return withCsp(request);
  if (!canAccess(pathname, roles)) return guard(forbidden(request, roles));
  return withCsp(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|api/auth).*)"],
};

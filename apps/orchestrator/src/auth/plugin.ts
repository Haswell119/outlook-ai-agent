import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { Routes } from "@oao/shared";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { timingSafeEqualString } from "../util/hash.js";
import { createAadVerifier } from "./aad.js";
import { adminTokenIdentity, devIdentity } from "./dev.js";
import type { AuthenticatedUser, Role } from "./identity.js";
import { hasRole } from "./identity.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

/**
 * Unauthenticated routes.
 * The Kubernetes probes are here on purpose: kubelet cannot present a bearer
 * token, and a probe that 401s is a probe that restarts healthy pods.
 * `/metrics` guards itself with `METRICS_TOKEN`.
 */
const PUBLIC_PATHS = new Set<string>([Routes.health, Routes.live, Routes.ready, Routes.features, Routes.metrics]);
const PUBLIC_PREFIXES = ["/api/v1/docs"];

/** Exact match, or a `/`-delimited child of the prefix — never `/api/v1/docsomething`. */
const underPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Fixed-window throttle on *failed* authentications, keyed by source address.
 *
 * The global rate limiter runs after this hook and keys on the authenticated
 * identity, so without this a caller could brute-force `ADMIN_API_TOKEN` or
 * replay tokens as fast as the network allows. Bounded by construction: the
 * whole map is dropped at the end of each window.
 */
const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_MAX = 20;

export class AuthFailureThrottle {
  private counts = new Map<string, number>();
  private windowStartedAt: number;
  constructor(
    private readonly max = AUTH_FAILURE_MAX,
    private readonly windowMs = AUTH_FAILURE_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.windowStartedAt = this.now();
  }

  private roll(): void {
    if (this.now() - this.windowStartedAt < this.windowMs) return;
    this.counts = new Map();
    this.windowStartedAt = this.now();
  }

  /** Throws 429 once `max` failures have been seen from `key` in the window. */
  check(key: string): void {
    this.roll();
    if ((this.counts.get(key) ?? 0) >= this.max) throw new AppError("rate_limited", "Too many failed authentication attempts");
  }

  record(key: string): void {
    this.roll();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

const bearerOf = (req: FastifyRequest): string | undefined => {
  const auth = req.headers.authorization;
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
};

/**
 * Authentication plugin: sets `request.user` for every non-public route.
 *  - `Authorization: Bearer <ADMIN_API_TOKEN>` → admin identity (both modes)
 *  - dev  → x-user-email / x-user-name headers
 *  - aad  → Azure AD JWT (JWKS, tenant allow-list, optional required scope)
 */
export const authPlugin = fp(async (app: FastifyInstance, cfg: Config) => {
  const verifyAad =
    cfg.AUTH_MODE === "aad"
      ? createAadVerifier({
          tenantId: cfg.AAD_TENANT_ID!,
          clientId: cfg.AAD_CLIENT_ID!,
          adminEmails: cfg.ADMIN_EMAILS,
          complianceEmails: cfg.COMPLIANCE_EMAILS,
          allowedTenants: cfg.AAD_ALLOWED_TENANTS,
          requiredScope: cfg.AAD_REQUIRE_SCOPE,
          clockToleranceSeconds: cfg.AAD_CLOCK_SKEW_SECONDS,
        })
      : undefined;
  const adminToken = cfg.ADMIN_API_TOKEN && cfg.ADMIN_API_TOKEN !== "change-me" ? cfg.ADMIN_API_TOKEN : cfg.NODE_ENV === "production" ? undefined : cfg.ADMIN_API_TOKEN;

  const throttle = new AuthFailureThrottle();
  app.decorateRequest("user", undefined as unknown as AuthenticatedUser);
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => underPrefix(path, p)) || req.method === "OPTIONS") return;
    const bearer = bearerOf(req);
    // Constant-time: `===` on a shared secret leaks its prefix through timing.
    if (bearer && adminToken && timingSafeEqualString(bearer, adminToken)) {
      req.user = adminTokenIdentity(cfg.ADMIN_EMAILS);
      return;
    }
    if (cfg.AUTH_MODE === "dev") {
      req.user = devIdentity(req.headers as Record<string, string | string[] | undefined>, { adminEmails: cfg.ADMIN_EMAILS, complianceEmails: cfg.COMPLIANCE_EMAILS });
      return;
    }
    throttle.check(req.ip);
    if (!bearer) {
      throttle.record(req.ip);
      throw AppError.unauthorized("Missing bearer token");
    }
    try {
      req.user = await verifyAad!(bearer);
    } catch (e) {
      throttle.record(req.ip);
      throw e;
    }
  });
});

/**
 * Opportunistic registration of the caller's mailbox for background
 * precomputation (delegated / OBO mode). Registered as a separate plugin so it
 * runs *after* auth and never blocks the request: the promise is not awaited.
 */
export const precomputeRegistrationPlugin = fp(async (app: FastifyInstance, opts: { register: (req: FastifyRequest) => Promise<void> }) => {
  app.addHook("onRequest", async (req) => {
    if (!req.user?.token) return;
    void opts.register(req).catch(() => undefined);
  });
});

/** Route guard factory: `preHandler: requireRole("admin")`. */
export const requireRole =
  (...roles: Role[]) =>
  async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw AppError.unauthorized();
    if (!roles.some((r) => hasRole(req.user, r))) throw AppError.forbidden(`Requires role: ${roles.join(" or ")}`);
  };

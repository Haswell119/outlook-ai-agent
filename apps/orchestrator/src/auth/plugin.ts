import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { createAadVerifier } from "./aad.js";
import { adminTokenIdentity, devIdentity } from "./dev.js";
import type { AuthenticatedUser, Role } from "./identity.js";
import { hasRole } from "./identity.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthenticatedUser;
  }
}

const PUBLIC_PATHS = new Set(["/api/v1/health", "/api/v1/config/features"]);

const bearerOf = (req: FastifyRequest): string | undefined => {
  const auth = req.headers.authorization;
  return auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
};

/**
 * Authentication plugin: sets `request.user` for every non-public route.
 *  - `Authorization: Bearer <ADMIN_API_TOKEN>` → admin identity (both modes)
 *  - dev  → x-user-email / x-user-name headers
 *  - aad  → Azure AD JWT
 */
export const authPlugin = fp(async (app: FastifyInstance, cfg: Config) => {
  const verifyAad = cfg.AUTH_MODE === "aad" ? createAadVerifier({ tenantId: cfg.AAD_TENANT_ID!, clientId: cfg.AAD_CLIENT_ID!, adminEmails: cfg.ADMIN_EMAILS, complianceEmails: cfg.COMPLIANCE_EMAILS }) : undefined;
  const adminToken = cfg.ADMIN_API_TOKEN && cfg.ADMIN_API_TOKEN !== "change-me" ? cfg.ADMIN_API_TOKEN : cfg.NODE_ENV === "production" ? undefined : cfg.ADMIN_API_TOKEN;

  app.decorateRequest("user", undefined as unknown as AuthenticatedUser);
  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (PUBLIC_PATHS.has(path) || req.method === "OPTIONS") return;
    const bearer = bearerOf(req);
    if (bearer && adminToken && bearer === adminToken) {
      req.user = adminTokenIdentity(cfg.ADMIN_EMAILS);
      return;
    }
    if (cfg.AUTH_MODE === "dev") {
      req.user = devIdentity(req.headers as Record<string, string | string[] | undefined>, { adminEmails: cfg.ADMIN_EMAILS, complianceEmails: cfg.COMPLIANCE_EMAILS });
      return;
    }
    if (!bearer) throw AppError.unauthorized("Missing bearer token");
    req.user = await verifyAad!(bearer);
  });
});

/** Route guard factory: `preHandler: requireRole("admin")`. */
export const requireRole =
  (...roles: Role[]) =>
  async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw AppError.unauthorized();
    if (!roles.some((r) => hasRole(req.user, r))) throw AppError.forbidden(`Requires role: ${roles.join(" or ")}`);
  };

/**
 * Auth.js endpoints (`/api/auth/signin`, `/callback/microsoft-entra-id`,
 * `/session`, `/signout`, …). Mounted in both modes; in
 * `ADMIN_AUTH_MODE=token` nothing ever calls them.
 */
import { handlers } from "@/auth";

export const { GET, POST } = handlers;

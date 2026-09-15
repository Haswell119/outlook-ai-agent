import type { Config } from "../config.js";
import { rolesFor } from "../auth/identity.js";
import type { AuditService } from "./AuditService.js";

export interface AdminUserRow {
  userId: string;
  email: string;
  displayName: string;
  roles: string[];
  events: number;
  lastActivity: string;
}

/** Admin: users seen in the audit trail, with their (env-derived) roles. */
export class UsersService {
  constructor(
    private readonly audit: AuditService,
    private readonly cfg: Config,
  ) {}

  async list(): Promise<AdminUserRow[]> {
    const rows = await this.audit.users();
    return rows.map((r) => ({ userId: r.userId, email: r.email, displayName: r.displayName ?? r.email, roles: rolesFor(r.email, this.cfg.ADMIN_EMAILS, this.cfg.COMPLIANCE_EMAILS), events: r.events, lastActivity: r.lastActivity }));
  }
}

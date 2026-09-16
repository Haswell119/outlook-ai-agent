import type { Policy } from "@oao/shared";
import { DEFAULT_POLICY, PolicySchema } from "@oao/shared";
import type { AuthenticatedUser } from "../auth/identity.js";
import { AppError } from "../errors.js";
import type { PolicyRepository } from "../ports/repositories.js";
import { nowIso } from "../util/ids.js";
import { checkPattern } from "../util/text.js";
import type { AuditService } from "./AuditService.js";

export class PolicyService {
  private cache: { policy: Policy; at: number } | undefined;
  /**
   * `internalDomains` from `INTERNAL_DOMAINS`, applied to the *default* policy
   * only. Once an admin has saved a policy row it is the single source of
   * truth — an env change must never silently rewrite a policy someone signed
   * off in the Policy Center.
   */
  constructor(
    private readonly repo: PolicyRepository,
    private readonly audit: AuditService,
    private readonly internalDomainsFromEnv: string[] = [],
  ) {}

  async get(): Promise<Policy> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.policy;
    const stored = await this.repo.get();
    const policy = stored ?? { ...DEFAULT_POLICY, internalDomains: this.internalDomainsFromEnv.length ? this.internalDomainsFromEnv : DEFAULT_POLICY.internalDomains };
    this.cache = { policy, at: Date.now() };
    return policy;
  }

  async put(user: AuthenticatedUser, input: unknown): Promise<Policy> {
    const policy = PolicySchema.parse({ ...(input as object), updatedAt: nowIso(), updatedBy: user.email });
    // A pattern that cannot be compiled is silently skipped by the rules engine,
    // i.e. a compliance control that looks configured and detects nothing. A
    // backtracking-prone one takes the whole process down on the next check.
    // Both are refused here rather than discovered in production.
    const rejected = policy.sensitiveDataPatterns
      .map((p) => ({ name: p.name, pattern: p.pattern, problem: checkPattern(p.pattern) }))
      .filter((p): p is { name: string; pattern: string; problem: NonNullable<ReturnType<typeof checkPattern>> } => p.problem !== undefined);
    if (rejected.length) {
      throw AppError.validation(
        `Unusable sensitive-data pattern(s): ${rejected.map((r) => `${r.name || "(unnamed)"} — ${r.problem.reason}`).join("; ")}`,
        rejected.map((r) => ({ path: `sensitiveDataPatterns.${r.name}`, message: r.problem.detail })),
      );
    }
    await this.repo.put(policy);
    this.cache = undefined;
    await this.audit.record({ user, type: "policy_updated", approvalStatus: "n/a", details: { internalDomains: policy.internalDomains, blockOnHighRisk: policy.blockOnHighRisk, requiredClassificationLabels: policy.requiredClassificationLabels, complianceApprovalFor: policy.complianceApprovalFor } });
    return policy;
  }
}

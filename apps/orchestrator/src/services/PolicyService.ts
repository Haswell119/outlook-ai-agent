import type { Policy } from "@oao/shared";
import { DEFAULT_POLICY, PolicySchema } from "@oao/shared";
import type { AuthenticatedUser } from "../auth/identity.js";
import type { PolicyRepository } from "../ports/repositories.js";
import { nowIso } from "../util/ids.js";
import type { AuditService } from "./AuditService.js";

export class PolicyService {
  private cache: { policy: Policy; at: number } | undefined;
  constructor(
    private readonly repo: PolicyRepository,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<Policy> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.policy;
    const stored = await this.repo.get();
    const policy = stored ?? DEFAULT_POLICY;
    this.cache = { policy, at: Date.now() };
    return policy;
  }

  async put(user: AuthenticatedUser, input: unknown): Promise<Policy> {
    const policy = PolicySchema.parse({ ...(input as object), updatedAt: nowIso(), updatedBy: user.email });
    await this.repo.put(policy);
    this.cache = undefined;
    await this.audit.record({ user, type: "policy_updated", approvalStatus: "n/a", details: { internalDomains: policy.internalDomains, blockOnHighRisk: policy.blockOnHighRisk, requiredClassificationLabels: policy.requiredClassificationLabels, complianceApprovalFor: policy.complianceApprovalFor } });
    return policy;
  }
}

import type { Repositories } from "../../ports/repositories.js";
import { PgActionRepository } from "./ActionRepository.js";
import { PgAuditRepository } from "./AuditRepository.js";
import { PgAutomationRepository, PgUserActionEventRepository } from "./AutomationRepository.js";
import { PgChatRepository } from "./ChatRepository.js";
import { PgEmailIndexRepository } from "./EmailIndexRepository.js";
import { PgEscalationRepository } from "./EscalationRepository.js";
import { PgAnalysisCacheRepository, PgDailyBriefRepository, PgEmbeddingCacheRepository, PgIdempotencyRepository, PgMailboxSyncRepository } from "./CacheRepository.js";
import { PgFeedbackRepository, PgPolicyRepository } from "./PolicyRepository.js";
import type { PgPool } from "./pool.js";

export function createPgRepositories(pool: PgPool): Repositories {
  return {
    audit: new PgAuditRepository(pool),
    emailIndex: new PgEmailIndexRepository(pool),
    chat: new PgChatRepository(pool),
    actions: new PgActionRepository(pool),
    escalations: new PgEscalationRepository(pool),
    automations: new PgAutomationRepository(pool),
    userActionEvents: new PgUserActionEventRepository(pool),
    policy: new PgPolicyRepository(pool),
    feedback: new PgFeedbackRepository(pool),
    analysisCache: new PgAnalysisCacheRepository(pool),
    embeddingCache: new PgEmbeddingCacheRepository(pool),
    mailboxSync: new PgMailboxSyncRepository(pool),
    dailyBriefs: new PgDailyBriefRepository(pool),
    idempotency: new PgIdempotencyRepository(pool),
    ping: async (timeoutMs) => {
      try {
        await Promise.race([pool.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs))]);
        return { ok: true, detail: "postgres reachable" };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },
    close: () => pool.end(),
  };
}

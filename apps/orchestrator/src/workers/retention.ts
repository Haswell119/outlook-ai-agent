import type { Config } from "../config.js";
import type { Logger } from "../services/context.js";
import type { Repositories } from "../ports/repositories.js";
import { nowIso } from "../util/ids.js";

/**
 * Nightly retention / purge job.
 *
 * `audit_events` is the legal trace: it is kept for `AUDIT_RETENTION_DAYS`
 * (default 730 = 2 years) and never purged faster. `email_index` holds email
 * text and is kept for `INDEX_RETENTION_DAYS` (default 365). Caches and
 * idempotency keys are pure derived data and are purged as soon as they expire.
 *
 * Deletes run in bounded batches (see the repositories) so a first run on a
 * large table does not hold one long transaction.
 */
export interface RetentionReport {
  auditEvents: number;
  emailChunks: number;
  analysisCache: number;
  embeddingCache: number;
  idempotency: number;
  dailyBriefs: number;
}

export async function runRetention(repos: Repositories, cfg: Config, logger: Logger): Promise<RetentionReport> {
  const now = Date.now();
  const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const safe = async (label: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (e) {
      logger.warn({ err: (e as Error).message, label }, "retention step failed");
      return 0;
    }
  };

  const report: RetentionReport = {
    auditEvents: await safe("audit", () => repos.audit.purgeOlderThan(iso(cfg.AUDIT_RETENTION_DAYS))),
    emailChunks: await safe("email_index", () => repos.emailIndex.purgeOlderThan(iso(cfg.INDEX_RETENTION_DAYS))),
    analysisCache: await safe("analysis_cache", () => repos.analysisCache.purgeExpired(nowIso())),
    embeddingCache: await safe("embedding_cache", () => repos.embeddingCache.purgeExpired(nowIso())),
    idempotency: await safe("idempotency", () => repos.idempotency.purgeExpired(nowIso())),
    // Briefs are derived from the index, so they follow the index retention.
    dailyBriefs: await safe("daily_briefs", () => repos.dailyBriefs.purgeOlderThan(iso(cfg.INDEX_RETENTION_DAYS).slice(0, 10))),
  };
  logger.info(report, "retention purge completed");
  return report;
}

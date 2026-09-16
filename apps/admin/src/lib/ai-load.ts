/**
 * "AI load" analytics: how many analyses actually reached the GPU.
 *
 * `EmailAnalysis.source` (`llm` | `cache` | `precomputed` | `heuristic`) is
 * mirrored into the audit details by the orchestrator. It is optional, so the
 * dashboard has to cope with periods where nothing carries it and show "n/a"
 * rather than a misleading 0 %.
 */
import type { AuditEvent } from "@oao/shared";

export const AI_SOURCES = ["llm", "cache", "precomputed", "heuristic"] as const;
export type AiSource = (typeof AI_SOURCES)[number];

export interface AiLoadBreakdown {
  /** Number of audit events that carry a usable `source`. */
  classified: number;
  total: number;
  counts: Record<AiSource, number>;
  shares: Record<AiSource, number>;
  /** Model calls avoided (cache + precomputed + heuristic). */
  avoided: number;
  /** `false` when no event of the period carries `source`. */
  available: boolean;
  /** Average generation time of the model calls, in seconds (for the GPU estimate). */
  avgGenerationSeconds: number;
}

/** Reads `details.source` (tolerating a nested `analysis.source`). */
export function eventAiSource(event: AuditEvent): AiSource | undefined {
  const details = event.details as Record<string, unknown> | undefined;
  const direct = details?.source;
  const nested = (details?.analysis as Record<string, unknown> | undefined)?.source;
  const raw = typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
  return AI_SOURCES.includes(raw as AiSource) ? (raw as AiSource) : undefined;
}

const DEFAULT_GENERATION_SECONDS = 2.5;

export function aiLoadBreakdown(events: AuditEvent[]): AiLoadBreakdown {
  const counts: Record<AiSource, number> = { llm: 0, cache: 0, precomputed: 0, heuristic: 0 };
  let classified = 0;
  let latencySum = 0;
  let latencyCount = 0;

  for (const event of events) {
    const source = eventAiSource(event);
    if (!source) continue;
    counts[source] += 1;
    classified += 1;
    if (source === "llm" && typeof event.latencyMs === "number" && event.latencyMs > 0) {
      latencySum += event.latencyMs;
      latencyCount += 1;
    }
  }

  const shares: Record<AiSource, number> = { llm: 0, cache: 0, precomputed: 0, heuristic: 0 };
  if (classified > 0) {
    for (const source of AI_SOURCES) shares[source] = (counts[source] / classified) * 100;
  }

  return {
    classified,
    total: events.length,
    counts,
    shares,
    avoided: counts.cache + counts.precomputed + counts.heuristic,
    available: classified > 0,
    avgGenerationSeconds:
      latencyCount > 0 ? latencySum / latencyCount / 1000 : DEFAULT_GENERATION_SECONDS,
  };
}

/**
 * Rough GPU saving: every avoided model call would have occupied the GPU for
 * about as long as an average generation.
 */
export function estimatedGpuMinutesSaved(breakdown: AiLoadBreakdown): number {
  if (!breakdown.available) return 0;
  return Math.round((breakdown.avoided * breakdown.avgGenerationSeconds) / 60);
}

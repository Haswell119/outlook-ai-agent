/**
 * The AI-load minimisation policy, in one place.
 *
 * Opening an email resolves its analysis through three tiers, cheapest first:
 *
 *   1. **Local cache** (IndexedDB, keyed by item id + content hash + language,
 *      TTL 24 h).
 *      Zero network, zero model. Switching back and forth between two emails is
 *      instant and silent.
 *   2. **`GET /analyze/email/:id`** with the *stable REST id* (so it matches the
 *      ids the mailbox-sync worker precomputed). 200 → render immediately with a
 *      "Precomputed" / "From cache" badge. 404 → the worker has not seen this
 *      message, fall through.
 *   3. **`POST /analyze/email`** — the only path that may spend a model call.
 *
 * A triaged email (newsletter, notification, out-of-office…) stops at tier 2:
 * the compact layout is shown and the model is only called when the user
 * explicitly presses "Analyse anyway" (`force`).
 *
 * `refresh()` sets `bypass`, which skips *and deletes* the local entry and goes
 * straight to tier 3 — the documented Cache-Control-like semantics.
 */
import type { EmailAnalysis, EmailContext, Language } from "@oao/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OaoApi } from "@/api";
import { readCached, writeCached } from "@/cache/analysisCache";
import { toStableEmailId } from "@/office/env";
import { emailContentHash, hashParts } from "@/util/hash";
import { track } from "@/telemetry";
import type { DisplaySource } from "@/ui/SourceBadge";

/** Triage kinds that get the compact one-line layout. */
export const COMPACT_TRIAGE_KINDS = new Set(["newsletter", "notification", "out_of_office", "automatic", "calendar", "trivial"]);

export function isCompactTriage(analysis: EmailAnalysis | null | undefined): boolean {
  const kind = analysis?.triage?.kind;
  return !!kind && COMPACT_TRIAGE_KINDS.has(kind);
}

export interface AnalysisState {
  data: EmailAnalysis | null;
  error: unknown;
  loading: boolean;
  /** Where the rendered analysis came from (drives the badge). */
  source: DisplaySource | undefined;
  /** Age of a locally cached entry, ms (undefined when it came from the network). */
  ageMs: number | undefined;
  /** Re-run, bypassing every cache (costs a model call). */
  refresh: () => void;
  /** Ask the model for a full analysis of a triaged email. */
  analyseAnyway: () => void;
  /** True while a forced/refresh analysis is running over an existing result. */
  revalidating: boolean;
}

export interface UseAnalysisOptions {
  api: OaoApi;
  email: EmailContext | null;
  lang: Language;
  /** Test seam: skip Office.js id conversion. */
  stableIdOf?: (itemId: string) => string;
}

type Mode = "auto" | "refresh" | "force";

export function useAnalysis({ api, email, lang, stableIdOf = toStableEmailId }: UseAnalysisOptions): AnalysisState {
  const [data, setData] = useState<EmailAnalysis | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [source, setSource] = useState<DisplaySource | undefined>(undefined);
  const [ageMs, setAgeMs] = useState<number | undefined>(undefined);
  const [request, setRequest] = useState<{ mode: Mode; tick: number }>({ mode: "auto", tick: 0 });

  const run = useRef(0);
  const emailId = email?.id ?? "";
  /**
   * The language is part of the key: an analysis is written *in* a language, so
   * the FR/EN toggle must not serve the English text from the cache. It also
   * means switching back is still free.
   */
  const hash = useMemo(() => (email ? hashParts([emailContentHash(email), lang]) : ""), [email, lang]);

  useEffect(() => {
    if (!email) return;
    const myRun = ++run.current;
    const { mode } = request;
    const bypass = mode !== "auto";
    const hadData = data !== null && mode !== "auto";

    if (hadData) setRevalidating(true);
    else setLoading(true);
    setError(null);

    const finish = (next: EmailAnalysis | null, nextSource: DisplaySource | undefined, nextAge?: number) => {
      if (run.current !== myRun) return false;
      if (next) {
        setData(next);
        setSource(nextSource);
        setAgeMs(nextAge);
      }
      setLoading(false);
      setRevalidating(false);
      return true;
    };

    void (async () => {
      const started = Date.now();
      try {
        // Tier 1 — local cache.
        if (!bypass) {
          const hit = await readCached<EmailAnalysis>("analysis", emailId, hash);
          if (hit) {
            track("analysis.resolved", { source: "local", ms: Date.now() - started, cacheHit: true });
            finish(hit.value, "local", hit.ageMs);
            return;
          }
        } else {
          // Drop the stale entry so a later "auto" load cannot resurrect it.
          await readCached<EmailAnalysis>("analysis", emailId, hash, { bypass: true });
        }
        if (run.current !== myRun) return;

        // Tier 2 — precomputed / server-cached, by stable id.
        if (mode !== "refresh" && mode !== "force") {
          const stableId = stableIdOf(emailId);
          if (stableId) {
            const precomputed = await api.analysisByEmail(stableId).catch(() => null);
            if (run.current !== myRun) return;
            // A precomputed analysis written in another language is worse than
            // useless — showing English to a French user breaks trust — so we
            // fall through to the model. Telemetry records it so operations can
            // see that the worker is precomputing in the wrong language.
            if (precomputed && precomputed.language && precomputed.language !== lang) {
              track("analysis.languageMismatch", { lang, source: precomputed.source ?? "precomputed" }, { severity: "warning" });
            } else if (precomputed) {
              const resolved: DisplaySource = precomputed.source === "cache" ? "cache" : precomputed.source === "heuristic" ? "heuristic" : "precomputed";
              track("analysis.resolved", { source: resolved, ms: Date.now() - started, triage: precomputed.triage?.kind });
              await writeCached("analysis", emailId, hash, precomputed);
              finish(precomputed, resolved);
              return;
            }
          }
        }
        if (run.current !== myRun) return;

        // Tier 3 — the model.
        const fresh = await api.analyzeEmail({ email, language: lang, includeThread: false });
        if (run.current !== myRun) return;
        await writeCached("analysis", emailId, hash, fresh);
        track("analysis.resolved", { source: fresh.source ?? "llm", ms: Date.now() - started, bypass });
        finish(fresh, (fresh.source as DisplaySource | undefined) ?? "llm");
      } catch (err) {
        if (run.current !== myRun) return;
        setError(err);
        setLoading(false);
        setRevalidating(false);
      }
    })();
    // `data` is intentionally not a dependency: it only decides skeleton vs
    // in-place revalidation, and adding it would re-run the effect on success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailId, hash, lang, api, request]);

  // A new item (or a changed body) resets the rendered result.
  useEffect(() => {
    setData(null);
    setSource(undefined);
    setAgeMs(undefined);
    setRequest({ mode: "auto", tick: 0 });
  }, [emailId, hash]);

  const refresh = useCallback(() => setRequest((r) => ({ mode: "refresh", tick: r.tick + 1 })), []);
  const analyseAnyway = useCallback(() => setRequest((r) => ({ mode: "force", tick: r.tick + 1 })), []);

  return { data, error, loading, revalidating, source, ageMs, refresh, analyseAnyway };
}

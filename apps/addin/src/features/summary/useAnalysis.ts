/**
 * The AI-load minimisation policy, in one place.
 *
 * Opening an email resolves its analysis through three tiers, cheapest first:
 *
 *   1. **Local cache** (IndexedDB, keyed by mailbox + item id + content hash +
 *      language, TTL 24 h).
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
 *
 * **Keying.** The rendered result belongs to one (item, content, language)
 * triple. When any of them changes the previous result is dropped *during the
 * render that sees the new key*, and the in-flight request is aborted, so the
 * pane can never show the previous email's analysis next to the new email's
 * subject, and a slow model call for an email the user has already left cannot
 * land on screen (nor keep a connection open).
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

/**
 * Risk code the orchestrator adds when the model failed and the answer is a
 * heuristic fallback. It is the difference between "rules were enough here"
 * (a triaged newsletter) and "the AI is down, this is all we could do".
 */
export const DEGRADED_RISK_CODE = "ai_output_unreliable";

/** True when this analysis is a *degraded* fallback rather than a deliberate rules-only answer. */
export function isDegraded(analysis: EmailAnalysis | null | undefined): boolean {
  if (!analysis) return false;
  return (analysis.risks ?? []).some((r) => r.code === DEGRADED_RISK_CODE);
}

/** True when the model produced nothing usable (blank summary and no content). */
export function isEmptyAnalysis(analysis: EmailAnalysis | null | undefined): boolean {
  if (!analysis) return false;
  const hasText = (analysis.summary ?? "").trim().length > 0;
  return !hasText && (analysis.decisions ?? []).length === 0 && (analysis.pendingTasks ?? []).length === 0 && (analysis.risks ?? []).length === 0;
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
  /**
   * True when the rendered result came from an explicit "Analyse anyway" /
   * Refresh. It is how the UI can say "you asked for the model and the
   * orchestrator still triaged this email", instead of redrawing the same card
   * and looking broken.
   */
  forced: boolean;
  /** Subject of the email this state describes (for the loading / empty states). */
  subject: string;
}

export interface UseAnalysisOptions {
  api: OaoApi;
  email: EmailContext | null;
  lang: Language;
  /** Test seam: skip Office.js id conversion. */
  stableIdOf?: (itemId: string) => string;
}

type Mode = "auto" | "refresh" | "force";

interface Request {
  mode: Mode;
  tick: number;
}

const AUTO: Request = { mode: "auto", tick: 0 };

export function useAnalysis({ api, email, lang, stableIdOf = toStableEmailId }: UseAnalysisOptions): AnalysisState {
  const [data, setData] = useState<EmailAnalysis | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [source, setSource] = useState<DisplaySource | undefined>(undefined);
  const [ageMs, setAgeMs] = useState<number | undefined>(undefined);
  const [request, setRequest] = useState<Request>(AUTO);
  const [forced, setForced] = useState(false);

  const run = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const emailId = email?.id ?? "";
  /**
   * The language is part of the key: an analysis is written *in* a language, so
   * the FR/EN toggle must not serve the English text from the cache. It also
   * means switching back is still free.
   */
  const hash = useMemo(() => (email ? hashParts([emailContentHash(email), lang]) : ""), [email, lang]);

  /**
   * Reset **during render**, not in an effect.
   *
   * An effect runs after the browser has painted, so resetting there showed the
   * previous email's analysis under the new email's subject for a frame (and
   * for as long as the new read took, when the read was slow). Adjusting state
   * while rendering is React's documented answer to "the inputs changed"; it
   * re-renders before committing anything.
   */
  const keyRef = useRef<string>(`${emailId}\u0000${hash}`);
  const key = `${emailId}\u0000${hash}`;
  if (keyRef.current !== key) {
    keyRef.current = key;
    // Cancel whatever is in flight for the previous item: its result is no
    // longer wanted, and on a slow model call it would otherwise keep running.
    run.current++;
    inFlight.current?.abort();
    inFlight.current = null;
    if (data !== null) setData(null);
    if (source !== undefined) setSource(undefined);
    if (ageMs !== undefined) setAgeMs(undefined);
    if (error !== null) setError(null);
    if (revalidating) setRevalidating(false);
    if (request !== AUTO) setRequest(AUTO);
    if (forced) setForced(false);
    if (!loading && email) setLoading(true);
  }

  useEffect(() => {
    if (!email) {
      setLoading(false);
      return;
    }
    const myRun = ++run.current;
    const { mode } = request;
    const bypass = mode !== "auto";
    const hadData = data !== null && mode !== "auto";
    const controller = new AbortController();
    inFlight.current = controller;

    if (hadData) setRevalidating(true);
    else setLoading(true);
    setError(null);

    const stale = () => run.current !== myRun || controller.signal.aborted;

    const finish = (next: EmailAnalysis | null, nextSource: DisplaySource | undefined, nextAge?: number) => {
      if (stale()) return false;
      if (next) {
        setData(next);
        setSource(nextSource);
        setAgeMs(nextAge);
        setForced(mode !== "auto");
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
            if (stale()) return;
            track("analysis.resolved", { source: "local", ms: Date.now() - started, cacheHit: true });
            finish(hit.value, "local", hit.ageMs);
            return;
          }
        } else {
          // Drop the stale entry so a later "auto" load cannot resurrect it.
          await readCached<EmailAnalysis>("analysis", emailId, hash, { bypass: true });
        }
        if (stale()) return;

        // Tier 2 — precomputed / server-cached, by stable id.
        if (mode !== "refresh" && mode !== "force") {
          const stableId = stableIdOf(emailId);
          if (stableId) {
            const precomputed = await api.analysisByEmail(stableId, { signal: controller.signal }).catch(() => null);
            if (stale()) return;
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
        if (stale()) return;

        // Tier 3 — the model.
        const fresh = await api.analyzeEmail({ email, language: lang, includeThread: false, force: mode === "force" || mode === "refresh" }, { signal: controller.signal });
        if (stale()) return;
        await writeCached("analysis", emailId, hash, fresh);
        track("analysis.resolved", { source: fresh.source ?? "llm", ms: Date.now() - started, bypass });
        finish(fresh, (fresh.source as DisplaySource | undefined) ?? "llm");
      } catch (err) {
        // An abort is not a failure: the user moved to another email.
        if (stale()) return;
        setError(err);
        setLoading(false);
        setRevalidating(false);
      }
    })();

    return () => {
      // Unmounting (or a new request) must not leave a model call running.
      if (inFlight.current === controller) inFlight.current = null;
      controller.abort();
    };
    // `data` is intentionally not a dependency: it only decides skeleton vs
    // in-place revalidation, and adding it would re-run the effect on success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailId, hash, lang, api, request]);

  const refresh = useCallback(() => setRequest((r) => ({ mode: "refresh", tick: r.tick + 1 })), []);
  const analyseAnyway = useCallback(() => setRequest((r) => ({ mode: "force", tick: r.tick + 1 })), []);

  return { data, error, loading, revalidating, source, ageMs, refresh, analyseAnyway, forced, subject: email?.subject ?? "" };
}

import { Button, makeStyles, Spinner, Switch, Tab, TabList, Tooltip, type SelectTabData } from "@fluentui/react-components";
import { ArrowSync20Regular } from "@fluentui/react-icons";
import type { EmailContext, ThreadContext, ThreadSynthesis } from "@oao/shared";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { readCurrentItem, readThread } from "@/office";
import { eventFromEmail, observeUserAction } from "@/office/observe";
import { readCached, writeCached } from "@/cache/analysisCache";
import { hashParts, threadContentHash } from "@/util/hash";
import { track } from "@/telemetry";
import { ErrorState, Skeleton, colors } from "@/ui";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { SummaryTab } from "@/features/summary/SummaryTab";
import { useAnalysis } from "@/features/summary/useAnalysis";
import { LazyChatTab, LazyDailyBriefView, LazyInsightsTab, LazyThreadView, PREFETCH_BY_TAB, prefetchWhenIdle } from "@/features/lazy";
import { useApp } from "./AppContext";
import { Header } from "./Header";
import { useAsync } from "./useAsync";

const useStyles = makeStyles({
  tabs: {
    backgroundColor: colors.card,
    borderBottom: `1px solid ${colors.border}`,
    paddingInline: "4px",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    position: "sticky",
    top: "47px",
    zIndex: 4,
  },
  tabList: { flexGrow: 1, minWidth: 0 },
  content: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px" },
  switchRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
});

export type TabKey = "summary" | "chat" | "insights" | "brief";

const TAB_KEYS: TabKey[] = ["summary", "chat", "insights", "brief"];

function initialTabOf(value: string | null | undefined): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : "summary";
}

export function ReadMode({ initialTab, initialView }: { initialTab?: string | null; initialView?: string | null }) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api, features } = useApp();
  const [tab, setTab] = useState<TabKey>(() => initialTabOf(initialTab));
  const [wholeThread, setWholeThread] = useState(initialView === "thread");
  const liveRef = useRef<HTMLDivElement>(null);

  // 1. current item
  const emailState = useAsync<EmailContext>(() => readCurrentItem(), []);
  const email = emailState.data;

  useEffect(() => {
    if (email) observeUserAction(eventFromEmail("open_email", email));
  }, [email]);

  // 2. analysis — precomputed / cached first, model last (see useAnalysis).
  const analysis = useAnalysis({ api, email, lang });

  // 3. thread synthesis — never automatic: only when the user flips the switch.
  const [thread, setThread] = useState<ThreadContext | null>(null);
  const synthesis = useAsync<ThreadSynthesis>(
    async () => {
      const th = await readThread(email!);
      setThread(th);
      const hash = hashParts([threadContentHash(th.messages), lang]);
      const hit = await readCached<ThreadSynthesis>("thread", th.conversationId, hash);
      if (hit) {
        track("thread.resolved", { source: "local", cacheHit: true });
        return hit.value;
      }
      const fresh = await api.analyzeThread({ thread: th, language: lang });
      await writeCached("thread", th.conversationId, hash, fresh);
      track("thread.resolved", { source: "llm" });
      return fresh;
    },
    [email?.id, lang, api],
    !!email && wholeThread,
  );

  useEffect(() => {
    if (analysis.data) prefetchWhenIdle();
  }, [analysis.data]);

  const refresh = useCallback(() => {
    if (wholeThread) synthesis.reload();
    else analysis.refresh();
  }, [wholeThread, synthesis, analysis]);

  const onTab = useCallback((key: TabKey) => {
    setTab(key);
    track("ui.tab", { tab: key });
  }, []);

  const briefEnabled = features?.dailyBriefEnabled !== false;
  const visibleTabs = useMemo(() => TAB_KEYS.filter((k) => k !== "brief" || briefEnabled), [briefEnabled]);

  const busy = analysis.loading || analysis.revalidating || (wholeThread && synthesis.loading);

  return (
    <>
      <Header />
      <nav className={s.tabs} aria-label={t("app.sections")}>
        <TabList
          className={s.tabList}
          selectedValue={tab}
          onTabSelect={(_, d: SelectTabData) => onTab(d.value as TabKey)}
          size="small"
        >
          {visibleTabs.map((key) => (
            <Tab key={key} value={key} onMouseEnter={() => PREFETCH_BY_TAB[key]?.()} onFocus={() => PREFETCH_BY_TAB[key]?.()} data-testid={`tab-${key}`}>
              {t(`tabs.${key}`)}
            </Tab>
          ))}
        </TabList>
        {tab === "summary" && (
          <Tooltip content={t("app.refreshHint")} relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={analysis.revalidating ? <Spinner size="extra-tiny" /> : <ArrowSync20Regular />}
              onClick={refresh}
              aria-label={t("app.refresh")}
              disabled={busy}
              data-testid="refresh"
            />
          </Tooltip>
        )}
      </nav>

      <main className={s.content} id="oao-main" tabIndex={-1}>
        {/* Loading / source announcements for assistive technology. */}
        <div ref={liveRef} aria-live="polite" aria-atomic="true" className="oao-visually-hidden">
          {busy ? t("summary.analyzing") : analysis.data && analysis.source ? t(`source.${analysis.source}`) : ""}
        </div>

        {emailState.loading && <Skeleton cards={3} />}
        {!!emailState.error && <ErrorState error={emailState.error} onRetry={emailState.reload} hint={t("errors.officeUnavailable")} />}

        {email && tab === "summary" && (
          <ErrorBoundary feature="summary">
            <div className={s.switchRow}>
              <Switch
                label={t("app.wholeConversation")}
                checked={wholeThread}
                onChange={(_, d) => setWholeThread(d.checked)}
                data-testid="whole-conversation"
              />
            </div>
            {wholeThread ? (
              <Suspense fallback={<Skeleton cards={4} label={t("thread.synthesizing")} />}>
                <LazyThreadView email={email} thread={thread} state={synthesis} />
              </Suspense>
            ) : (
              <SummaryTab email={email} state={analysis} />
            )}
          </ErrorBoundary>
        )}

        {email && tab === "chat" && (
          <ErrorBoundary feature="chat">
            <Suspense fallback={<Skeleton cards={2} />}>
              <LazyChatTab email={email} />
            </Suspense>
          </ErrorBoundary>
        )}

        {email && tab === "insights" && (
          <ErrorBoundary feature="insights">
            <Suspense fallback={<Skeleton cards={3} />}>
              <LazyInsightsTab email={email} analysis={analysis.data} loading={analysis.loading} source={analysis.source} />
            </Suspense>
          </ErrorBoundary>
        )}

        {tab === "brief" && (
          <ErrorBoundary feature="brief">
            <Suspense fallback={<Skeleton cards={4} />}>
              <LazyDailyBriefView />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </>
  );
}

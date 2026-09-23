import { Button, makeStyles, Spinner, Switch, Tab, TabList, Text, Tooltip, type SelectTabData } from "@fluentui/react-components";
import { ArrowSync20Regular } from "@fluentui/react-icons";
import type { EmailContext, ThreadContext, ThreadSynthesis } from "@oao/shared";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import { currentItemSubject, NoItemError, readCurrentItem, readThread } from "@/office";
import { eventFromEmail, observeUserAction } from "@/office/observe";
import { readCached, writeCached } from "@/cache/analysisCache";
import { hashParts, threadContentHash } from "@/util/hash";
import { track } from "@/telemetry";
import { EmptyState, ErrorState, Skeleton, colors } from "@/ui";
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
  item: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
  itemSubject: { fontSize: "13px", fontWeight: 600, color: colors.text, lineHeight: "18px", overflowWrap: "anywhere" },
  itemFrom: { fontSize: "12px", color: colors.textSecondary, lineHeight: "16px", overflowWrap: "anywhere" },
  switchRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
});

export type TabKey = "summary" | "chat" | "insights" | "brief";

const TAB_KEYS: TabKey[] = ["summary", "chat", "insights", "brief"];

function initialTabOf(value: string | null | undefined): TabKey {
  return TAB_KEYS.includes(value as TabKey) ? (value as TabKey) : "summary";
}

export interface ReadModeProps {
  initialTab?: string | null;
  initialView?: string | null;
  /**
   * Bumped by the app shell on `ItemChanged` (pinned pane, the user clicked
   * another message in the list). Re-reads the item, which then re-resolves the
   * analysis through the three tiers — cache first, so switching back and forth
   * stays free.
   */
  itemVersion?: number;
  /**
   * Id of the message the host currently has selected, resolved by the app
   * shell. It is the **key** of everything on this screen: the item read, the
   * analysis, the thread synthesis and the chat transcript. Anything that does
   * not carry this id belongs to another email and is never rendered.
   */
  itemId?: string;
  /** Reports the selected tab, so the shell can restore it after a hot reload on the next email. */
  onTabChange?: (tab: TabKey) => void;
}

export function ReadMode({ initialTab, initialView, itemVersion = 0, itemId = "", onTabChange }: ReadModeProps) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api, features } = useApp();
  const [tab, setTab] = useState<TabKey>(() => initialTabOf(initialTab));
  const [wholeThread, setWholeThread] = useState(initialView === "thread");
  const liveRef = useRef<HTMLDivElement>(null);

  // 1. current item (re-read whenever the pinned pane follows the selection).
  //    `itemId` is part of the key, so a value read for the previous message is
  //    dropped before it can be painted (see useAsync).
  const emailState = useAsync<EmailContext>(() => readCurrentItem(), [itemId, itemVersion]);
  /**
   * Belt and braces: even a value that arrived for this key is ignored when the
   * host has moved on in the meantime (a read that was already in flight when
   * the user clicked the next message).
   */
  const loaded = emailState.data;
  const email = loaded && (!itemId || !loaded.id || loaded.id === itemId) ? loaded : null;
  const switching = !!loaded && !email;

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

  const onTab = useCallback(
    (key: TabKey) => {
      setTab(key);
      onTabChange?.(key);
      track("ui.tab", { tab: key });
    },
    [onTabChange],
  );

  const briefEnabled = features?.dailyBriefEnabled !== false;
  const visibleTabs = useMemo(() => TAB_KEYS.filter((k) => k !== "brief" || briefEnabled), [briefEnabled]);

  const busy = emailState.loading || switching || analysis.loading || analysis.revalidating || (wholeThread && synthesis.loading);
  /**
   * Subject of the item being analysed. Read straight from the host (it is
   * available synchronously, long before the body) so the loading state names
   * the email the pane is working on instead of being anonymous.
   */
  const hostSubject = useMemo(() => currentItemSubject(), [itemId, itemVersion]);
  const pendingSubject = (hostSubject || email?.subject || "").trim();

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

        {/* Which email this screen is about. Without it, a pane that is slow —
            or that the host moved to another message — is indistinguishable
            from a pane stuck on the previous email. */}
        {/* …except on the Brief tab, which is mailbox-wide and not about this email. */}
        {tab !== "brief" && (pendingSubject || email) && (
          <div className={s.item}>
            <Text className={s.itemSubject} data-testid="item-subject" block>
              {pendingSubject || t("selection.noSubject")}
            </Text>
            {email?.from && (
              <Text className={s.itemFrom} data-testid="item-from" block>
                {email.from.name ? `${email.from.name} · ${email.from.address}` : email.from.address}
              </Text>
            )}
          </div>
        )}

        {(emailState.loading || switching) && !email && (
          <Skeleton cards={3} label={t("summary.analyzing")} />
        )}
        {!!emailState.error && !email && (
          emailState.error instanceof NoItemError ? (
            <EmptyState title={t("read.noItemTitle")} description={t("read.noItemBody")} />
          ) : (
            <ErrorState error={emailState.error} onRetry={emailState.reload} hint={t("errors.officeUnavailable")} />
          )
        )}

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
              {/* Keyed by item: a chat transcript must never carry over to another email. */}
              <LazyChatTab key={email.id} email={email} />
            </Suspense>
          </ErrorBoundary>
        )}

        {email && tab === "insights" && (
          <ErrorBoundary feature="insights">
            <Suspense fallback={<Skeleton cards={3} />}>
              <LazyInsightsTab
                email={email}
                analysis={analysis.data}
                loading={analysis.loading}
                error={analysis.error}
                source={analysis.source}
                onRetry={analysis.refresh}
              />
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

/**
 * "Home" mode — the pane running **without a mailbox item at all**.
 *
 * Three ways to get here:
 *   - the **Apps rail** of the new Outlook / Outlook on the web: the personal
 *     tab declared by `staticTabs` in the unified manifest opens
 *     `taskpane.html?view=home&host=tab`. There is no `Office.context.mailbox`
 *     in that host, so every Office.js call must stay guarded.
 *   - the **pinned pane with nothing selected** (`SupportsNoItemContext`): the
 *     mailbox is there but `Office.context.mailbox.item` is `null`, so there is
 *     nothing to analyse and everything mailbox-wide still applies.
 *   - `?view=home` in a browser, which is the same surface against the real
 *     backend (this is *not* preview mode: no sample email, no "Preview mode"
 *     pill — see `isPreviewMode()` in `office/env.ts`).
 *
 * What it shows is everything that is mailbox-wide rather than item-bound: the
 * daily brief, the chat over the indexed mailbox, the precomputation status and
 * the settings. The item-dependent features (summary, thread synthesis,
 * compliance on a draft) are hidden, with one honest line saying where to find
 * them: open an email.
 */
import { makeStyles, Tab, TabList, Text, type SelectTabData } from "@fluentui/react-components";
import { MailRead20Regular } from "@fluentui/react-icons";
import { Suspense, useCallback, useState } from "react";
import { useI18n } from "@/i18n";
import { LazyChatTab, LazyDailyBriefView, LazySyncStatusPill, PREFETCH_BY_TAB } from "@/features/lazy";
import { track } from "@/telemetry";
import { SectionCard, Skeleton, colors } from "@/ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";

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
  content: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: colors.background },
  hint: { display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12px", color: colors.textSecondary },
});

export type HomeTab = "brief" | "chat";

const HOME_TABS: HomeTab[] = ["brief", "chat"];

export interface HomeModeProps {
  initialTab?: string | null;
}

export function HomeMode({ initialTab }: HomeModeProps) {
  const s = useStyles();
  const { t } = useI18n();
  const [tab, setTab] = useState<HomeTab>(HOME_TABS.includes(initialTab as HomeTab) ? (initialTab as HomeTab) : "brief");

  const onTab = useCallback((key: HomeTab) => {
    setTab(key);
    track("ui.tab", { tab: key, view: "home" });
  }, []);

  return (
    <>
      <Header subtitle={t("home.subtitle")} />
      <nav className={s.tabs} aria-label={t("app.sections")}>
        <TabList className={s.tabList} selectedValue={tab} onTabSelect={(_, d: SelectTabData) => onTab(d.value as HomeTab)} size="small">
          {HOME_TABS.map((key) => (
            <Tab key={key} value={key} onMouseEnter={() => PREFETCH_BY_TAB[key]?.()} onFocus={() => PREFETCH_BY_TAB[key]?.()} data-testid={`tab-${key}`}>
              {t(`tabs.${key}`)}
            </Tab>
          ))}
        </TabList>
      </nav>

      <main className={s.content} id="oao-main" tabIndex={-1} data-testid="home-mode">
        <SectionCard icon={<MailRead20Regular />} testId="home-hint">
          <div className={s.hint}>
            <Text size={200}>{t("home.openEmailHint")}</Text>
          </div>
        </SectionCard>

        {tab === "brief" && (
          <>
            <ErrorBoundary feature="brief">
              <Suspense fallback={<Skeleton cards={4} label={t("brief.loading")} />}>
                <LazyDailyBriefView />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary feature="insights">
              <Suspense fallback={<Skeleton cards={1} />}>
                <LazySyncStatusPill />
              </Suspense>
            </ErrorBoundary>
          </>
        )}

        {tab === "chat" && (
          <ErrorBoundary feature="chat">
            <Suspense fallback={<Skeleton cards={2} />}>
              <LazyChatTab />
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </>
  );
}

import { Button, makeStyles, Switch, Tab, TabList, Tooltip, type SelectTabData } from "@fluentui/react-components";
import { ArrowSync20Regular } from "@fluentui/react-icons";
import type { EmailAnalysis, EmailContext, ThreadContext, ThreadSynthesis } from "@oao/shared";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { readCurrentItem, readThread } from "@/office";
import { eventFromEmail, observeUserAction } from "@/office/observe";
import { ErrorState, Skeleton, colors } from "@/ui";
import { SummaryTab } from "@/features/summary/SummaryTab";
import { ThreadView } from "@/features/thread/ThreadView";
import { ChatTab } from "@/features/chat/ChatTab";
import { InsightsTab } from "@/features/insights/InsightsTab";
import { useApp } from "./AppContext";
import { Header } from "./Header";
import { useAsync } from "./useAsync";

const useStyles = makeStyles({
  tabs: { backgroundColor: colors.card, borderBottom: `1px solid ${colors.border}`, padding: "0 4px", display: "flex", alignItems: "center", gap: "4px", position: "sticky", top: "47px", zIndex: 4 },
  tabList: { flexGrow: 1 },
  content: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px" },
  switchRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
});

type TabKey = "summary" | "chat" | "insights";

export function ReadMode({ initialTab, initialView }: { initialTab?: string | null; initialView?: string | null }) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api } = useApp();
  const [tab, setTab] = useState<TabKey>(initialTab === "chat" || initialTab === "insights" ? initialTab : "summary");
  const [wholeThread, setWholeThread] = useState(initialView === "thread");

  // 1. current item
  const emailState = useAsync<EmailContext>(() => readCurrentItem(), []);
  const email = emailState.data;

  useEffect(() => {
    if (email) observeUserAction(eventFromEmail("open_email", email));
  }, [email]);

  // 2. analysis (re-runs when the language changes so the answer is in the user's language)
  const analysis = useAsync<EmailAnalysis>(() => api.analyzeEmail({ email: email!, language: lang, includeThread: false }), [email?.id, lang, api], !!email);

  // 3. thread synthesis (lazy, when the switch is on)
  const [thread, setThread] = useState<ThreadContext | null>(null);
  const synthesis = useAsync<ThreadSynthesis>(
    async () => {
      const th = await readThread(email!);
      setThread(th);
      return api.analyzeThread({ thread: th, language: lang });
    },
    [email?.id, lang, api],
    !!email && wholeThread,
  );

  const refresh = useCallback(() => {
    if (wholeThread) synthesis.reload();
    else analysis.reload();
  }, [wholeThread, synthesis, analysis]);

  return (
    <>
      <Header />
      <div className={s.tabs}>
        <TabList className={s.tabList} selectedValue={tab} onTabSelect={(_, d: SelectTabData) => setTab(d.value as TabKey)} size="small">
          <Tab value="summary">{t("tabs.summary")}</Tab>
          <Tab value="chat">{t("tabs.chat")}</Tab>
          <Tab value="insights">{t("tabs.insights")}</Tab>
        </TabList>
        {tab === "summary" && (
          <Tooltip content={t("app.refresh")} relationship="label">
            <Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} onClick={refresh} aria-label={t("app.refresh")} data-testid="refresh" />
          </Tooltip>
        )}
      </div>

      <div className={s.content}>
        {emailState.loading && <Skeleton cards={3} />}
        {!!emailState.error && <ErrorState error={emailState.error} onRetry={emailState.reload} hint={t("errors.officeUnavailable")} />}

        {email && tab === "summary" && (
          <>
            <div className={s.switchRow}>
              <Switch label={t("app.wholeConversation")} checked={wholeThread} onChange={(_, d) => setWholeThread(d.checked)} data-testid="whole-conversation" />
            </div>
            {wholeThread ? (
              <ThreadView email={email} thread={thread} state={synthesis} />
            ) : (
              <SummaryTab email={email} state={analysis} />
            )}
          </>
        )}
        {email && tab === "chat" && <ChatTab email={email} />}
        {email && tab === "insights" && <InsightsTab email={email} analysis={analysis.data} loading={analysis.loading} />}
      </div>
    </>
  );
}

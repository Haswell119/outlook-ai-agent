/**
 * "Selection" view — the pane opened on **several messages selected in the
 * list**, with none of them open.
 *
 * It is deliberately a menu, not an automatic analysis: reading N messages is
 * cheap, synthesising them is a model call. So the view first lists what Outlook
 * says is selected (and tells the truth when it could only read the subjects),
 * then offers three explicit moves:
 *
 *   1. **Synthesise these N emails** — `POST /analyze/thread` with a synthetic
 *      `ThreadContext` whose `conversationId` is `selection:<hash>`. The result
 *      is rendered by the existing thread-synthesis screen and cached under the
 *      same key, so coming back to the same selection is free.
 *   2. **Ask about the selection** — the chat, scoped to `selection:<hash>`
 *      after the selected messages have been indexed once.
 *   3. **Review proposed actions** — the existing approval dialog, seeded with
 *      the synthesis (`analysisAuditId`) so it does not re-run the model.
 *
 * On a host without Mailbox 1.13 the view says so instead of failing.
 */
import { Button, makeStyles, Spinner, Text } from "@fluentui/react-components";
import { ChatMultiple20Regular, Checkmark20Regular, Info20Regular, MailMultiple20Regular, Open16Regular, Sparkle20Filled, TaskListSquareLtr20Regular, Warning20Regular } from "@fluentui/react-icons";
import type { ThreadContext, ThreadSynthesis } from "@oao/shared";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useApp } from "@/app/AppContext";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { useAsync } from "@/app/useAsync";
import { readCached, writeCached } from "@/cache/analysisCache";
import { LazyActionApprovalDialog, LazyChatTab, LazyThreadView } from "@/features/lazy";
import { formatDate, useI18n } from "@/i18n";
import { openMessage } from "@/office/actions";
import { readSelectedItems, selectionEmailsForIndex, selectionThread, type SelectionContext } from "@/office/selection";
import { toPlainText } from "@/security/sanitize";
import { track } from "@/telemetry";
import { hashParts, threadContentHash } from "@/util/hash";
import { ErrorState, SectionCard, Skeleton, colors, useToast } from "@/ui";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  item: { borderTop: `1px solid ${colors.border}` },
  itemFirst: { borderTop: "none" },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
    width: "100%",
    paddingBlock: "8px",
    paddingInline: "4px",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "6px",
    textAlign: "start",
    cursor: "pointer",
    fontFamily: "inherit",
    color: colors.text,
    ":hover": { backgroundColor: colors.primaryTint },
    ":focus-visible": { outline: `2px solid ${colors.focus}`, outlineOffset: "-2px" },
  },
  main: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  subject: { fontWeight: 600, fontSize: "13px", lineHeight: "17px" },
  meta: { color: colors.textSecondary, fontSize: "12px", lineHeight: "16px" },
  index: { color: colors.textSecondary, fontSize: "12px", minWidth: "16px", paddingTop: "1px" },
  actions: { display: "flex", flexDirection: "column", gap: "6px" },
  hintRow: { display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12px", color: colors.textSecondary },
  toolbar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
});

type SubView = "list" | "synthesis" | "chat";

export interface SelectionViewProps {
  /** Bumped by the app shell on `SelectedItemsChanged` so the list re-reads. */
  itemVersion?: number;
  /** `?tab=chat` opens straight in the scoped chat. */
  initialTab?: string | null;
}

export function SelectionView({ itemVersion = 0, initialTab }: SelectionViewProps) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api } = useApp();
  const toast = useToast();
  const [view, setView] = useState<SubView>(initialTab === "chat" ? "chat" : "list");
  const [approval, setApproval] = useState(false);

  const state = useAsync<SelectionContext>(() => readSelectedItems(), [itemVersion]);
  const selection = state.data;
  const count = selection?.items.length ?? 0;

  const thread = useMemo<ThreadContext | null>(
    () => (selection ? selectionThread(selection, t("selection.threadSubject", { count })) : null),
    [selection, count, t],
  );

  const [wantSynthesis, setWantSynthesis] = useState(false);
  const synthesis = useAsync<ThreadSynthesis>(
    async () => {
      const th = thread!;
      const hash = hashParts([threadContentHash(th.messages), lang]);
      const hit = await readCached<ThreadSynthesis>("thread", th.conversationId, hash);
      if (hit) {
        track("selection.resolved", { source: "local", cacheHit: true, count });
        return hit.value;
      }
      const fresh = await api.analyzeThread({ thread: th, language: lang });
      await writeCached("thread", th.conversationId, hash, fresh);
      track("selection.resolved", { source: "llm", count });
      return fresh;
    },
    [selection?.id, lang, api],
    !!thread && wantSynthesis,
  );

  const synthesise = useCallback(() => {
    setWantSynthesis(true);
    setView("synthesis");
  }, []);

  const openItem = useCallback(
    (id: string, webLink?: string) => {
      if (!openMessage(id, webLink)) toast.info(t("chat.openFailed"));
    },
    [t, toast],
  );

  const reviewActions = useCallback(() => {
    if (!synthesis.data) {
      // "Review proposed actions" proposes *from the synthesis*, so it needs one.
      synthesise();
      toast.info(t("selection.synthesiseFirst"));
      return;
    }
    setApproval(true);
  }, [synthesis.data, synthesise, t, toast]);

  if (state.loading && !selection) return <Skeleton cards={2} label={t("selection.loading")} />;
  if (state.error && !selection) return <ErrorState error={state.error} onRetry={state.reload} />;

  if (!selection?.supported) {
    return (
      <SectionCard icon={<Warning20Regular />} iconColor={colors.mediumText} iconBg={colors.mediumBg} title={t("selection.title")} testId="selection-unsupported">
        <Text size={300} block>
          {t("selection.unsupported")}
        </Text>
        <Text size={200} style={{ color: colors.textSecondary, marginTop: "6px" }} block>
          {t("selection.unsupportedHint")}
        </Text>
      </SectionCard>
    );
  }

  if (count === 0) {
    return (
      <SectionCard icon={<MailMultiple20Regular />} title={t("selection.title")} testId="selection-empty">
        <Text size={300}>{t("selection.empty")}</Text>
      </SectionCard>
    );
  }

  const list = (
    <div className={s.stack} data-testid="selection-view">
      <SectionCard icon={<MailMultiple20Regular />} title={t("selection.title")} testId="selection-list" actions={<Text className={s.meta}>{t("selection.count", { count })}</Text>}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {selection.items.map((item, i) => (
            <li key={item.id} className={i === 0 ? s.itemFirst : s.item}>
              <button type="button" className={s.row} onClick={() => openItem(item.id, item.webLink)} data-testid="selection-item">
                <span className={s.index}>{i + 1}.</span>
                <span className={s.main}>
                  <span className={s.subject}>{toPlainText(item.subject, 200) || t("selection.noSubject")}</span>
                  <span className={s.meta}>
                    {item.from ? toPlainText(item.from.name ?? item.from.address, 80) : t("selection.unknownSender")}
                    {item.receivedAt || item.sentAt ? ` · ${formatDate(item.receivedAt ?? item.sentAt, lang)}` : ""}
                  </span>
                </span>
                <Open16Regular style={{ color: colors.textSecondary, flexShrink: 0 }} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        {selection.degraded && (
          <div className={s.hintRow} style={{ marginTop: "8px" }} data-testid="selection-degraded">
            <Info20Regular style={{ color: colors.mediumText, flexShrink: 0 }} aria-hidden="true" />
            <span>{t("selection.degraded", { loaded: selection.loadedCount, count })}</span>
          </div>
        )}
      </SectionCard>

      <SectionCard icon={<Sparkle20Filled />} title={t("selection.whatNext")}>
        <div className={s.actions}>
          <Button appearance="primary" icon={<Checkmark20Regular />} onClick={synthesise} data-testid="selection-synthesise">
            {t("selection.synthesise", { count })}
          </Button>
          <Button appearance="outline" icon={<ChatMultiple20Regular />} onClick={() => setView("chat")} data-testid="selection-ask">
            {t("selection.ask")}
          </Button>
          <Button appearance="outline" icon={<TaskListSquareLtr20Regular />} onClick={reviewActions} data-testid="selection-actions">
            {t("selection.reviewActions")}
          </Button>
        </div>
        <Text className={s.meta} style={{ marginTop: "8px" }} block>
          {t("selection.costHint")}
        </Text>
      </SectionCard>
    </div>
  );

  const back = (
    <div className={s.toolbar}>
      <Button size="small" appearance="subtle" onClick={() => setView("list")} data-testid="selection-back">
        {t("selection.back", { count })}
      </Button>
      {view === "synthesis" && synthesis.data && (
        <Button size="small" appearance="outline" icon={<TaskListSquareLtr20Regular />} onClick={() => setApproval(true)} data-testid="selection-actions-inline">
          {t("selection.reviewActions")}
        </Button>
      )}
      {synthesis.loading && <Spinner size="extra-tiny" label={t("thread.synthesizing")} labelPosition="after" />}
    </div>
  );

  return (
    <div className={s.stack}>
      {view !== "list" && back}
      {view === "list" && list}

      {view === "synthesis" && thread && (
        <ErrorBoundary feature="thread">
          <Suspense fallback={<Skeleton cards={4} label={t("thread.synthesizing")} />}>
            <LazyThreadView email={selection.items[0]!} thread={thread} state={synthesis} />
          </Suspense>
        </ErrorBoundary>
      )}

      {view === "chat" && (
        <ErrorBoundary feature="chat">
          <Suspense fallback={<Skeleton cards={2} />}>
            <LazyChatTab
              fixedScope={{ conversationId: selection.id, label: t("selection.scope", { count }), emails: selectionEmailsForIndex(selection) }}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {approval && thread && (
        <Suspense fallback={null}>
          <LazyActionApprovalDialog
            open
            onClose={() => setApproval(false)}
            email={selection.items[0]}
            thread={thread}
            analysisAuditId={synthesis.data?.auditId}
          />
        </Suspense>
      )}
    </div>
  );
}

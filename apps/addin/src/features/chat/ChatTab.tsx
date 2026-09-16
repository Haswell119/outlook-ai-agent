import { Button, Input, makeStyles, mergeClasses, Spinner, Text, Tooltip } from "@fluentui/react-components";
import { CheckmarkCircle20Filled, DatabaseSearch20Regular, Open16Regular, Send20Filled } from "@fluentui/react-icons";
import type { ChatResponse, EmailContext } from "@oao/shared";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useApp } from "@/app/AppContext";
import { formatDate, useI18n } from "@/i18n";
import { loadRecentFromCache } from "@/office/cache";
import { openMessage } from "@/office/actions";
import { AiFooter, EmptyState, colors, useErrorMessage, useToast } from "@/ui";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "10px", minHeight: "calc(100vh - 120px)" },
  transcript: { display: "flex", flexDirection: "column", gap: "10px", flexGrow: 1 },
  userWrap: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" },
  userMeta: { color: colors.textSecondary, fontSize: "11px" },
  userBubble: { backgroundColor: colors.primaryTint, borderRadius: "12px 12px 2px 12px", padding: "8px 12px", maxWidth: "88%", fontSize: "13px" },
  card: { backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" },
  headline: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600, fontSize: "14px" },
  sectionTitle: { fontWeight: 600, fontSize: "12px", color: colors.textSecondary, textTransform: "uppercase", letterSpacing: "0.02em" },
  sourceRow: { display: "flex", gap: "8px", alignItems: "flex-start", padding: "6px 0", borderTop: `1px solid ${colors.border}` },
  sourceIndex: { color: colors.textSecondary, fontSize: "12px", minWidth: "14px" },
  sourceMain: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  sourceLink: { color: colors.primary, fontWeight: 600, fontSize: "13px", background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontFamily: "inherit" },
  sourceMeta: { color: colors.textSecondary, fontSize: "12px" },
  relevance: { color: colors.lowText, fontWeight: 600, fontSize: "13px", whiteSpace: "nowrap" },
  quote: { backgroundColor: colors.greenBg, borderLeft: `3px solid ${colors.lowText}`, borderRadius: "4px", padding: "8px 10px", fontSize: "13px", fontStyle: "italic" },
  quoteAuthor: { color: colors.textSecondary, fontSize: "12px", fontStyle: "normal", marginTop: "4px" },
  composer: { position: "sticky", bottom: 0, backgroundColor: colors.background, paddingTop: "6px", display: "flex", flexDirection: "column", gap: "6px" },
  composerRow: { display: "flex", gap: "6px", alignItems: "center" },
  chips: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
  chip: { borderRadius: "12px", fontSize: "11px", padding: "2px 10px", minHeight: "22px", height: "22px" },
  chipActive: { backgroundColor: colors.primary, color: "#fff", border: `1px solid ${colors.primary}` },
  hint: { color: colors.textSecondary, fontSize: "11px" },
});

interface Turn {
  role: "user" | "assistant";
  text: string;
  at: string;
  response?: ChatResponse;
}

export interface ChatTabProps {
  /** The opened message, when there is one (read pane). */
  email?: EmailContext | null;
  /**
   * A retrieval scope pinned by the caller — the multi-select selection view
   * passes `selection:<hash>` here. When `emails` is given they are indexed
   * (once, on the first question) so the scoped retrieval can find them.
   */
  fixedScope?: { conversationId: string; label: string; emails?: EmailContext[] };
}

export function ChatTab({ email, fixedScope }: ChatTabProps) {
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [scope, setScope] = useState<"conversation" | "all">(email?.conversationId ? "conversation" : "all");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  /** The pinned selection is indexed once per session, on the first question. */
  const indexedScope = useRef<string | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, busy]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setTurns((prev) => [...prev, { role: "user", text: message, at: new Date().toISOString() }]);
    setBusy(true);
    try {
      // A pinned scope only retrieves what has been indexed under it: index the
      // selected messages once, right before the first question.
      if (fixedScope?.emails?.length && indexedScope.current !== fixedScope.conversationId) {
        setIndexing(true);
        try {
          await api.indexEmails({ emails: fixedScope.emails });
          indexedScope.current = fixedScope.conversationId;
        } catch (e) {
          // Retrieval will be thinner, but the question still goes through.
          toast.info(errMsg(e));
        } finally {
          setIndexing(false);
        }
      }
      const res = await api.chat({
        sessionId,
        message,
        currentEmail: email ?? undefined,
        scope: fixedScope
          ? { conversationId: fixedScope.conversationId }
          : scope === "conversation" && email?.conversationId
            ? { conversationId: email.conversationId }
            : {},
        language: lang,
      });
      setSessionId(res.sessionId);
      setTurns((prev) => [...prev, { role: "assistant", text: res.answer, at: new Date().toISOString(), response: res }]);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const indexRecent = async () => {
    const emails = loadRecentFromCache(200);
    if (!emails.length) {
      toast.info(t("chat.nothingToIndex"));
      return;
    }
    setIndexing(true);
    try {
      const r = await api.indexEmails({ emails });
      toast.success(t("chat.indexed", { indexed: r.indexed, skipped: r.skipped, mode: r.mode }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setIndexing(false);
    }
  };

  const open = (emailId: string, webLink?: string) => {
    if (!openMessage(emailId, webLink)) toast.info(t("chat.openFailed"));
  };

  return (
    <div className={s.root} data-testid="chat-tab">
      <div className={s.transcript} role="log" aria-label={t("tabs.chat")}>
        {turns.length === 0 && !busy && (
          <EmptyState
            title={t("tabs.chat")}
            description={fixedScope ? t("selection.chatEmpty", { count: fixedScope.emails?.length ?? 0 }) : email ? t("chat.empty") : t("home.chatEmpty")}
            icon={<DatabaseSearch20Regular />}
          />
        )}
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className={s.userWrap}>
              <Text className={s.userMeta}>
                {t("chat.you")} {formatDate(turn.at, lang).split(",").pop()?.trim()}
              </Text>
              <div className={s.userBubble}>{turn.text}</div>
            </div>
          ) : (
            <div key={i} className={s.card} data-testid="assistant-card">
              {turn.response?.headline && (
                <div className={s.headline}>
                  <CheckmarkCircle20Filled style={{ color: colors.lowText }} />
                  {turn.response.headline}
                </div>
              )}
              <Text size={300}>{turn.text}</Text>

              {turn.response && turn.response.sources.length > 0 && (
                <div>
                  <div className={s.sectionTitle}>{t("chat.sourcesUsed")}</div>
                  {turn.response.sources.map((src, idx) => (
                    <div key={src.emailId} className={s.sourceRow} style={idx === 0 ? { borderTop: "none" } : undefined}>
                      <span className={s.sourceIndex}>{idx + 1}.</span>
                      <span className={s.sourceMain}>
                        <button type="button" className={s.sourceLink} onClick={() => open(src.emailId, src.webLink)}>
                          {src.subject}
                        </button>
                        <span className={s.sourceMeta}>
                          {src.from}
                          {src.date ? ` · ${formatDate(src.date, lang)}` : ""}
                        </span>
                      </span>
                      <span className={s.relevance}>{Math.round(src.relevance * 100)}%</span>
                    </div>
                  ))}
                </div>
              )}

              {turn.response?.evidence && (
                <div>
                  <div className={s.sectionTitle}>{t("chat.evidence")}</div>
                  <Text size={200} style={{ color: colors.textSecondary }}>
                    {t("chat.emailLabel", { subject: turn.response.evidence.subject })}
                  </Text>
                  <div className={s.quote} style={{ marginTop: "4px" }}>
                    “{turn.response.evidence.quote}”
                    <div className={s.quoteAuthor}>
                      — {turn.response.evidence.author}
                      {turn.response.evidence.date ? `, ${formatDate(turn.response.evidence.date, lang)}` : ""}
                    </div>
                  </div>
                  <Button size="small" appearance="outline" icon={<Open16Regular />} iconPosition="after" style={{ marginTop: "8px" }} onClick={() => open(turn.response!.evidence!.emailId, turn.response!.evidence!.webLink)}>
                    {t("chat.openOriginal")}
                  </Button>
                </div>
              )}
              <AiFooter auditId={turn.response?.auditId} />
            </div>
          ),
        )}
        {busy && <Spinner size="tiny" label={indexing ? t("selection.indexing") : t("chat.thinking")} labelPosition="after" />}
        {/* Announce the answer (and the wait) to assistive technology: a Fluent
            Spinner label alone is not reliably read out. */}
        <div aria-live="polite" aria-atomic="true" className="oao-visually-hidden">
          {busy ? t("chat.thinking") : (turns[turns.length - 1]?.role === "assistant" ? turns[turns.length - 1]!.text : "")}
        </div>
        <div ref={endRef} />
      </div>

      <div className={s.composer}>
        <div className={s.chips}>
          <Text className={s.hint}>{t("chat.scope")}:</Text>
          {fixedScope ? (
            <span className={mergeClasses(s.chip, s.chipActive)} data-testid="chat-fixed-scope" style={{ padding: "2px 10px", lineHeight: "18px" }}>
              {fixedScope.label}
            </span>
          ) : (
            <>
              {email?.conversationId && (
                <Button size="small" appearance="outline" className={mergeClasses(s.chip, scope === "conversation" && s.chipActive)} onClick={() => setScope("conversation")} aria-pressed={scope === "conversation"}>
                  {t("chat.scopeConversation")}
                </Button>
              )}
              <Button size="small" appearance="outline" className={mergeClasses(s.chip, scope === "all" && s.chipActive)} onClick={() => setScope("all")} aria-pressed={scope === "all"}>
                {t("chat.scopeAll")}
              </Button>
            </>
          )}
          {!fixedScope && (
            <Tooltip content={t("chat.indexHint")} relationship="description">
              <Button size="small" appearance="subtle" icon={indexing ? <Spinner size="extra-tiny" /> : <DatabaseSearch20Regular />} onClick={() => void indexRecent()} disabled={indexing} style={{ marginLeft: "auto" }}>
                {t("chat.indexRecent")}
              </Button>
            </Tooltip>
          )}
        </div>
        <div className={s.composerRow}>
          <Input value={input} onChange={(_, d) => setInput(d.value)} onKeyDown={onKey} placeholder={t("chat.placeholder")} style={{ flexGrow: 1 }} aria-label={t("chat.placeholder")} disabled={busy} />
          <Button appearance="primary" icon={<Send20Filled />} onClick={() => void send()} disabled={busy || !input.trim()} aria-label={t("chat.send")} />
        </div>
      </div>
    </div>
  );
}

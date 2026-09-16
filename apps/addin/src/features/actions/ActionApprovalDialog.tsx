import { Button, Checkbox, Dialog, DialogBody, DialogSurface, Link, makeStyles, mergeClasses, Spinner, Text } from "@fluentui/react-components";
import {
  CheckmarkCircle16Filled,
  Clock16Regular,
  Dismiss20Regular,
  DismissCircle16Filled,
  LockClosed16Regular,
  Open16Regular,
  Shield20Regular,
  ShieldCheckmark24Regular,
  Sparkle20Filled,
  Warning16Filled,
} from "@fluentui/react-icons";
import type { ActionProposal, ActionType, EmailContext, ProposedAction, ThreadContext } from "@oao/shared";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/app/AppContext";
import { useMediaQuery } from "@/app/useMediaQuery";
import { useI18n } from "@/i18n";
import { ErrorState, RiskBadge, Skeleton, colors, useToast } from "@/ui";
import { actionIcon, sourceIcon } from "./actionIcons";
import { executeApprovedResults, type ExecutedResult } from "./actionRunner";

const useStyles = makeStyles({
  surface: { width: "calc(100% - 16px)", maxWidth: "640px", padding: "0", borderRadius: "8px", overflow: "hidden" },
  body: { display: "flex", flexDirection: "column", gap: "10px", padding: "12px 14px 14px", maxHeight: "calc(100vh - 32px)", overflowY: "auto" },
  header: { display: "flex", alignItems: "center", gap: "8px" },
  headerTitle: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  brand: { color: colors.primary, fontWeight: 600, fontSize: "13px" },
  title: { fontWeight: 600, fontSize: "14px" },
  info: { backgroundColor: colors.primaryTint, border: "1px solid #B4D6FA", borderRadius: "8px", padding: "10px 12px", display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" },
  countRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  count: { fontWeight: 600 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "12px" },
  th: { textAlign: "left", color: colors.textSecondary, fontWeight: 600, padding: "6px 6px", borderBottom: `1px solid ${colors.border}`, fontSize: "11px" },
  td: { padding: "8px 6px", borderBottom: `1px solid ${colors.border}`, verticalAlign: "top" },
  actionCell: { display: "flex", gap: "6px", alignItems: "center", fontWeight: 600, color: colors.text },
  source: { display: "flex", gap: "6px", alignItems: "flex-start", color: colors.textSecondary },
  cards: { display: "flex", flexDirection: "column", gap: "8px" },
  card: { border: `1px solid ${colors.border}`, borderRadius: "8px", padding: "10px", display: "flex", gap: "8px", backgroundColor: colors.card, cursor: "pointer" },
  cardSelected: { border: `1px solid ${colors.primary}`, boxShadow: `inset 0 0 0 1px ${colors.primary}` },
  cardMain: { flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" },
  cardTitle: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600, fontSize: "13px", flexWrap: "wrap" },
  cardMeta: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", color: colors.textSecondary, fontSize: "12px" },
  explanation: { color: colors.text, fontSize: "12px" },
  humanBox: { backgroundColor: colors.background, border: `1px solid ${colors.border}`, borderRadius: "8px", padding: "10px 12px", display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12px", flexWrap: "wrap" },
  footer: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", paddingTop: "4px" },
  secure: { display: "inline-flex", alignItems: "center", gap: "4px", color: colors.textSecondary, fontSize: "12px", flexGrow: 1 },
  results: { display: "flex", flexDirection: "column", gap: "6px" },
  resultRow: { display: "flex", alignItems: "flex-start", gap: "8px", fontSize: "12px" },
});

export interface ActionApprovalDialogProps {
  open: boolean;
  onClose: () => void;
  email?: EmailContext;
  thread?: ThreadContext;
  /** Pre-filter the dialog to one action type (from a "+" button). */
  filterType?: ActionType;
  analysisAuditId?: string;
  /** Inject a proposal (tests) instead of calling the API. */
  proposal?: ActionProposal;
}

export function ActionApprovalDialog(props: ActionApprovalDialogProps) {
  const { open, onClose, email, thread, filterType, analysisAuditId } = props;
  const s = useStyles();
  const { t, lang } = useI18n();
  const { api, adminUrl } = useApp();
  const toast = useToast();
  const wide = useMediaQuery("(min-width: 480px)");

  const [proposal, setProposal] = useState<ActionProposal | null>(props.proposal ?? null);
  const [loading, setLoading] = useState(!props.proposal);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [approving, setApproving] = useState(false);
  const [results, setResults] = useState<ExecutedResult[] | null>(null);
  const [tick, setTick] = useState(0);

  const visibleOf = (p: ActionProposal) => (filterType && p.actions.some((a) => a.type === filterType) ? p.actions.filter((a) => a.type === filterType) : p.actions);

  useEffect(() => {
    if (!open) return;
    setResults(null);
    if (props.proposal) {
      setProposal(props.proposal);
      setSelected(new Set(visibleOf(props.proposal).filter((a) => a.selectedByDefault).map((a) => a.id)));
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .proposeActions({ email, thread, analysisAuditId, language: lang })
      .then((p) => {
        if (!alive) return;
        setProposal(p);
        setSelected(new Set(visibleOf(p).filter((a) => a.selectedByDefault).map((a) => a.id)));
      })
      .catch((e: unknown) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tick]);

  const actions: ProposedAction[] = useMemo(() => (proposal ? visibleOf(proposal) : []), [proposal, filterType]); // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = actions.length > 0 && actions.every((a) => selected.has(a.id));
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(actions.map((a) => a.id)) : new Set());

  const approve = async () => {
    if (!proposal || selected.size === 0) return;
    setApproving(true);
    try {
      const res = await api.approveActions({ proposalId: proposal.proposalId, actionIds: [...selected] });
      const collected: ExecutedResult[] = [];
      setResults([]);
      await executeApprovedResults(res.results, {
        api,
        lang,
        email,
        onProgress: (r) => {
          collected.push(r);
          setResults([...collected]);
          if (r.status === "manual" && r.message) toast.info(r.message);
        },
      });
    } catch (e) {
      setError(e);
    } finally {
      setApproving(false);
    }
  };

  const statusIcon = (st: ExecutedResult["status"]) => {
    switch (st) {
      case "executed":
        return <CheckmarkCircle16Filled style={{ color: colors.lowText }} />;
      case "pending_compliance":
        return <Clock16Regular style={{ color: colors.mediumText }} />;
      case "manual":
        return <Warning16Filled style={{ color: colors.mediumText }} />;
      default:
        return <DismissCircle16Filled style={{ color: colors.red }} />;
    }
  };
  const statusLabel = (st: ExecutedResult["status"]) =>
    st === "executed" ? t("approval.executed") : st === "pending_compliance" ? t("approval.pendingCompliance") : st === "rejected" ? t("approval.rejected") : st === "manual" ? t("actions.manualGeneric") : t("approval.failed");

  const titleFor = (aid: string) => proposal?.actions.find((a) => a.id === aid)?.title ?? aid;

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()} modalType="modal">
      <DialogSurface className={s.surface} aria-label={t("approval.title")}>
        <DialogBody className={s.body} style={{ display: "flex" }}>
          <div className={s.header}>
            <ShieldCheckmark24Regular style={{ color: colors.primary }} />
            <div className={s.headerTitle}>
              <Text className={s.brand}>{t("app.title")}</Text>
              <Text className={s.title}>{t("approval.title")}</Text>
            </div>
            <Link href={`${adminUrl}/audit`} target="_blank" rel="noopener" style={{ fontSize: "12px" }}>
              {t("approval.provideFeedback")}
            </Link>
            <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} onClick={onClose} aria-label={t("app.close")} />
          </div>

          {loading && <Skeleton cards={2} label={t("approval.preparing")} />}
          {!loading && error && <ErrorState error={error} onRetry={() => setTick((x) => x + 1)} />}

          {!loading && !error && proposal && results === null && (
            <>
              <div className={s.info}>
                <Sparkle20Filled style={{ color: colors.primary, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 600 }}>{t("approval.introTitle")}</div>
                  <div style={{ color: colors.textSecondary }}>{t("approval.introText")}</div>
                </div>
              </div>

              <div className={s.countRow}>
                <Text className={s.count} data-testid="proposed-count">
                  {t("approval.proposed", { count: actions.length })}
                </Text>
                <Checkbox label={t("approval.selectAll")} labelPosition="before" checked={allSelected} onChange={(_, d) => toggleAll(!!d.checked)} />
              </div>

              {actions.length === 0 && <Text>{t("approval.noActions")}</Text>}

              {actions.length > 0 && wide && (
                <table className={s.table} data-testid="actions-table">
                  <thead>
                    <tr>
                      <th className={s.th}>{t("approval.action")}</th>
                      <th className={s.th}>{t("approval.explanation")}</th>
                      <th className={s.th}>{t("approval.source")}</th>
                      <th className={s.th}>{t("approval.riskLevel")}</th>
                      <th className={s.th}>{t("approval.select")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actions.map((a) => (
                      <tr key={a.id}>
                        <td className={s.td}>
                          <span className={s.actionCell}>
                            <span style={{ color: colors.primary, display: "inline-flex" }}>{actionIcon(a.type)}</span>
                            {a.title}
                          </span>
                        </td>
                        <td className={s.td}>{a.explanation}</td>
                        <td className={s.td}>
                          <span className={s.source}>
                            {sourceIcon(a.source.kind)}
                            <span>
                              {a.source.label}
                              {a.source.detail && (
                                <>
                                  <br />
                                  <span style={{ fontSize: "11px" }}>{a.source.detail}</span>
                                </>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className={s.td}>
                          <RiskBadge level={a.riskLevel} />
                        </td>
                        <td className={s.td}>
                          <Checkbox checked={selected.has(a.id)} onChange={(_, d) => toggle(a.id, !!d.checked)} aria-label={a.title} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {actions.length > 0 && !wide && (
                <div className={s.cards} data-testid="actions-cards">
                  {actions.map((a) => (
                    <label key={a.id} className={mergeClasses(s.card, selected.has(a.id) && s.cardSelected)}>
                      <Checkbox checked={selected.has(a.id)} onChange={(_, d) => toggle(a.id, !!d.checked)} aria-label={a.title} />
                      <div className={s.cardMain}>
                        <span className={s.cardTitle}>
                          <span style={{ color: colors.primary, display: "inline-flex" }}>{actionIcon(a.type)}</span>
                          {a.title}
                          <RiskBadge level={a.riskLevel} />
                        </span>
                        <span className={s.explanation}>{a.explanation}</span>
                        <span className={s.cardMeta}>
                          {sourceIcon(a.source.kind)}
                          <span>
                            {a.source.label}
                            {a.source.detail ? ` · ${a.source.detail}` : ""}
                          </span>
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              <div className={s.humanBox}>
                <Shield20Regular style={{ color: colors.primary, flexShrink: 0 }} />
                <div style={{ flexGrow: 1, minWidth: "160px" }}>
                  <div style={{ fontWeight: 600 }}>{t("approval.humanValidation")}</div>
                  <div style={{ color: colors.textSecondary }}>{t("approval.humanValidationText")}</div>
                </div>
                <Button as="a" size="small" appearance="outline" icon={<Open16Regular />} iconPosition="after" href={`${adminUrl}/audit`} target="_blank" rel="noopener">
                  {t("approval.viewAuditLog")}
                </Button>
              </div>

              <div className={s.footer}>
                <span className={s.secure}>
                  <LockClosed16Regular /> {t("approval.secure")}
                </span>
                <Button appearance="primary" disabled={selected.size === 0 || approving} onClick={() => void approve()} icon={approving ? <Spinner size="tiny" /> : undefined} data-testid="approve-button">
                  {t("approval.approveSelected", { count: selected.size })}
                </Button>
                <Button appearance="secondary" onClick={onClose} disabled={approving}>
                  {t("app.cancel")}
                </Button>
              </div>
            </>
          )}

          {results !== null && (
            <>
              <Text weight="semibold">{t("approval.results")}</Text>
              <div className={s.results} data-testid="action-results">
                {results.map((r) => (
                  <div key={r.result.actionId} className={s.resultRow}>
                    {statusIcon(r.status)}
                    <div>
                      <div style={{ fontWeight: 600 }}>{titleFor(r.result.actionId)}</div>
                      <div style={{ color: colors.textSecondary }}>
                        {statusLabel(r.status)}
                        {r.message ? ` — ${r.message}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
                {approving && <Spinner size="tiny" label={t("app.loading")} />}
              </div>
              <div className={s.footer}>
                <span className={s.secure}>
                  <LockClosed16Regular /> {t("approval.secure")}
                </span>
                <Button appearance="primary" onClick={onClose} disabled={approving}>
                  {t("approval.done")}
                </Button>
              </div>
            </>
          )}
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

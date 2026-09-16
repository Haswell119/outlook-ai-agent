import { Button, Checkbox, Input, Link, makeStyles, mergeClasses, Spinner, Text, Tooltip } from "@fluentui/react-components";
import { ArrowRight16Regular, Beaker20Regular, CheckmarkCircle16Filled, Checkmark20Regular, DismissCircle16Filled, Edit20Regular, History20Regular, Info16Regular, Play20Regular, Search20Regular, Sparkle20Filled, Timer20Regular } from "@fluentui/react-icons";
import type { Automation } from "@oao/shared";
import { useState } from "react";
import { useApp } from "@/app/AppContext";
import { useAsync } from "@/app/useAsync";
import { useMediaQuery } from "@/app/useMediaQuery";
import { useI18n } from "@/i18n";
import { ConfidenceBar, ErrorState, RiskBadge, SectionCard, Skeleton, colors, useErrorMessage, useToast } from "@/ui";
import { actionIcon } from "@/features/actions/actionIcons";

const useStyles = makeStyles({
  stack: { display: "flex", flexDirection: "column", gap: "10px" },
  titleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" },
  title: { fontWeight: 600, fontSize: "14px", color: colors.primary },
  intro: { display: "flex", gap: "8px", alignItems: "flex-start" },
  label: { display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 600, fontSize: "13px" },
  steps: { display: "grid", gridTemplateColumns: "1fr", gap: "6px", alignItems: "stretch" },
  stepsWide: { gridTemplateColumns: "repeat(4, minmax(0, 1fr))" },
  step: { border: `1px solid ${colors.border}`, borderRadius: "8px", padding: "8px", display: "flex", flexDirection: "column", gap: "4px", backgroundColor: colors.card, position: "relative" },
  stepHead: { display: "flex", alignItems: "center", gap: "6px" },
  badge: { width: "18px", height: "18px", borderRadius: "50%", backgroundColor: colors.primary, color: "#fff", fontSize: "11px", fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  stepTitle: { fontWeight: 600, fontSize: "12px" },
  stepDesc: { color: colors.textSecondary, fontSize: "11px", wordBreak: "break-word" },
  arrow: { position: "absolute", right: "-11px", top: "50%", transform: "translateY(-50%)", color: colors.textSecondary, backgroundColor: colors.card, zIndex: 1 },
  pill: { backgroundColor: colors.lowBg, color: colors.lowText, borderRadius: "10px", padding: "1px 8px", fontSize: "11px", fontWeight: 600 },
  sim: { display: "grid", gridTemplateColumns: "1fr", gap: "10px" },
  simWide: { gridTemplateColumns: "1fr 1fr" },
  check: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" },
  time: { display: "flex", alignItems: "center", gap: "6px", marginTop: "6px", fontSize: "12px" },
  buttons: { display: "flex", gap: "6px", flexWrap: "wrap" },
  result: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "3px 0" },
  active: { display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderTop: `1px solid ${colors.border}`, fontSize: "12px" },
  editor: { display: "flex", flexDirection: "column", gap: "6px" },
});

function AutomationCard({ auto, onChange }: { auto: Automation; onChange: (a: Automation) => void }) {
  const s = useStyles();
  const { t } = useI18n();
  const { api, adminUrl } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const wide = useMediaQuery("(min-width: 480px)");
  const [busy, setBusy] = useState<"sim" | "approve" | "reject" | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Automation>(auto);

  const run = async (kind: "sim" | "approve" | "reject") => {
    setBusy(kind);
    try {
      const next = kind === "sim" ? await api.simulateAutomation(auto.id, { sampleSize: 10 }) : kind === "approve" ? await api.approveAutomation(auto.id, {}) : await api.rejectAutomation(auto.id, {});
      onChange({ ...next, trigger: auto.trigger, steps: auto.steps, name: auto.name });
      toast.success(t(kind === "sim" ? "automation.simulated" : kind === "approve" ? "automation.approved" : "automation.rejected"));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const sim = auto.lastSimulation;
  const minutes = Math.round(auto.stats.estimatedMinutesSavedPerWeek);

  return (
    <div className={s.stack} data-testid={`automation-${auto.id}`}>
      <SectionCard tint="blue">
        <div className={s.intro}>
          <Sparkle20Filled style={{ color: colors.primary, flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 600 }}>{t("automation.intro", { name: auto.description || auto.name })}</div>
            <div style={{ color: colors.textSecondary, fontSize: "12px" }}>{t("automation.stats", { perWeek: auto.stats.perWeek, minutes })}</div>
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <div className={s.titleRow}>
          <span className={s.label}>
            {t("automation.detectedWorkflow")}
            <Tooltip content={auto.trigger.description} relationship="description">
              <Info16Regular style={{ color: colors.textSecondary }} />
            </Tooltip>
          </span>
          <RiskBadge level={auto.riskLevel} />
        </div>
        <Text size={200} style={{ color: colors.textSecondary }}>
          {t("automation.triggeredBy")}: <strong style={{ color: colors.text }}>{auto.trigger.description}</strong>
        </Text>
        <div className={mergeClasses(s.steps, wide && s.stepsWide)} style={{ marginTop: "8px" }}>
          {auto.steps.map((step, i) => (
            <div key={step.order} className={s.step}>
              <div className={s.stepHead}>
                <span className={s.badge}>{step.order}</span>
                <span style={{ color: colors.primary, display: "inline-flex" }}>{actionIcon(step.type)}</span>
              </div>
              <span className={s.stepTitle}>{step.title}</span>
              <span className={s.stepDesc}>{step.description}</span>
              {wide && i < auto.steps.length - 1 && <ArrowRight16Regular className={s.arrow} />}
            </div>
          ))}
        </div>

        {editing && (
          <div className={s.editor} style={{ marginTop: "10px" }} data-testid="rule-editor">
            <Text weight="semibold" size={300}>
              {t("automation.editor.title")}
            </Text>
            <Text size={200} style={{ color: colors.textSecondary }}>
              {t("automation.editor.hint")}
            </Text>
            <Input size="small" value={draft.trigger.conditions.fromAddress ?? ""} placeholder={t("automation.editor.fromAddress")} onChange={(_, d) => setDraft({ ...draft, trigger: { ...draft.trigger, conditions: { ...draft.trigger.conditions, fromAddress: d.value || undefined } } })} />
            <Input size="small" value={draft.trigger.conditions.fromDomain ?? ""} placeholder={t("automation.editor.fromDomain")} onChange={(_, d) => setDraft({ ...draft, trigger: { ...draft.trigger, conditions: { ...draft.trigger.conditions, fromDomain: d.value || undefined } } })} />
            <Input size="small" value={draft.trigger.conditions.subjectContains ?? ""} placeholder={t("automation.editor.subjectContains")} onChange={(_, d) => setDraft({ ...draft, trigger: { ...draft.trigger, conditions: { ...draft.trigger.conditions, subjectContains: d.value || undefined } } })} />
            <Checkbox size="medium" label={t("automation.editor.hasAttachments")} checked={!!draft.trigger.conditions.hasAttachments} onChange={(_, d) => setDraft({ ...draft, trigger: { ...draft.trigger, conditions: { ...draft.trigger.conditions, hasAttachments: !!d.checked } } })} />
            <Text size={200} weight="semibold">
              {t("automation.editor.steps")}
            </Text>
            {draft.steps.map((st, i) => (
              <Input key={st.order} size="small" value={st.title} contentBefore={<span>{st.order}.</span>} onChange={(_, d) => setDraft({ ...draft, steps: draft.steps.map((x, j) => (j === i ? { ...x, title: d.value } : x)) })} />
            ))}
            <div className={s.buttons}>
              <Button size="small" appearance="primary" onClick={() => { onChange({ ...draft, trigger: { ...draft.trigger, description: describeTrigger(draft) } }); setEditing(false); }}>
                {t("automation.editor.save")}
              </Button>
              <Button size="small" onClick={() => { setDraft(auto); setEditing(false); }}>
                {t("automation.editor.cancel")}
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard>
        <div className={s.titleRow}>
          <span className={s.label}>
            {t("automation.simulationMode")}
            <Tooltip content={t("automation.simulateIntro", { count: 10 })} relationship="description">
              <Info16Regular style={{ color: colors.textSecondary }} />
            </Tooltip>
          </span>
          <span className={s.pill}>{t("automation.testBefore")}</span>
        </div>
        <div className={mergeClasses(s.sim, wide && s.simWide)} style={{ marginTop: "6px" }}>
          <div>
            <Text size={200}>{t("automation.simulateIntro", { count: sim?.sampleSize ?? 10 })}</Text>
            <div className={s.time}>
              <Timer20Regular style={{ color: colors.primary }} />
              <span>
                <strong>{t("automation.estimatedTimeSaved")}</strong>
                <br />
                {t("automation.minutesPerWeek", { minutes })}
              </span>
            </div>
          </div>
          <div>
            <Text size={200} weight="semibold">
              {t("automation.whatWeCheck")}
            </Text>
            {(sim?.checks ?? defaultChecks(t)).map((c) => (
              <div key={c.name} className={s.check}>
                {c.passed ? <CheckmarkCircle16Filled style={{ color: colors.lowText }} /> : <DismissCircle16Filled style={{ color: colors.red }} />}
                <span>
                  {c.name}
                  {c.detail ? <span style={{ color: colors.textSecondary }}> ({c.detail})</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>

        {sim && (
          <div style={{ marginTop: "8px" }} data-testid="simulation-results">
            <Text size={200} weight="semibold">
              {t("automation.simulationResults")} — {t("automation.sampleSize", { count: sim.sampleSize })}
            </Text>
            {sim.results.map((r) => (
              <div key={r.emailId} className={s.result}>
                {r.wouldApply ? <CheckmarkCircle16Filled style={{ color: colors.lowText }} /> : <DismissCircle16Filled style={{ color: colors.textSecondary }} />}
                <span style={{ flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subject}</span>
                <Tooltip content={r.stepsPreview.join(" → ")} relationship="description">
                  <span style={{ color: colors.textSecondary, whiteSpace: "nowrap" }}>{r.wouldApply ? t("automation.wouldApply") : t("automation.wouldSkip")}</span>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <div className={s.buttons}>
        <Button size="small" appearance="outline" icon={busy === "sim" ? <Spinner size="extra-tiny" /> : <Play20Regular />} disabled={busy !== null} onClick={() => void run("sim")}>
          {t("automation.runSimulation")}
        </Button>
        <Button size="small" appearance="outline" icon={<Edit20Regular />} disabled={busy !== null} onClick={() => setEditing((v) => !v)}>
          {t("automation.editRule")}
        </Button>
        <Button size="small" appearance="primary" icon={busy === "approve" ? <Spinner size="extra-tiny" /> : <Checkmark20Regular />} disabled={busy !== null} onClick={() => void run("approve")}>
          {t("automation.approve")}
        </Button>
        <Button size="small" appearance="subtle" disabled={busy !== null} onClick={() => void run("reject")}>
          {t("automation.reject")}
        </Button>
      </div>

      <div className={s.titleRow}>
        <ConfidenceBar value={auto.confidence} />
      </div>
      <Link href={`${adminUrl}/automations`} target="_blank" rel="noopener" style={{ fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
        {t("automation.viewHistory")} <History20Regular />
      </Link>
    </div>
  );
}

function describeTrigger(a: Automation): string {
  const c = a.trigger.conditions;
  const parts: string[] = [];
  if (c.fromAddress) parts.push(`from ${c.fromAddress}`);
  else if (c.fromDomain) parts.push(`from @${c.fromDomain}`);
  if (c.subjectContains) parts.push(`subject contains "${c.subjectContains}"`);
  if (c.hasAttachments) parts.push("with attachments");
  return parts.length ? `Emails ${parts.join(", ")}` : a.trigger.description;
}

function defaultChecks(t: (k: string) => string): Automation["lastSimulation"] extends infer S ? (S extends { checks: infer C } ? C : never) : never {
  void t;
  return [
    { name: "Attachment detection accuracy", passed: true },
    { name: "Correct folder mapping", passed: true },
    { name: "Category assignment", passed: true },
    { name: "Reminder creation", passed: true },
  ];
}

export function AutomationCoach() {
  const s = useStyles();
  const { t } = useI18n();
  const { api } = useApp();
  const toast = useToast();
  const errMsg = useErrorMessage();
  const state = useAsync<Automation[]>(() => api.listAutomations(), [api]);
  const [detecting, setDetecting] = useState(false);

  const list = state.data ?? [];
  const proposals = list.filter((a) => a.status === "proposed" || a.status === "simulated");
  const active = list.filter((a) => a.status === "active" || a.status === "approved" || a.status === "paused");

  const detect = async () => {
    setDetecting(true);
    try {
      const found = await api.detectAutomations();
      const merged = [...found, ...list.filter((a) => !found.some((f) => f.id === a.id))];
      state.setData(merged);
      toast.success(t("automation.detected", { count: found.length }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setDetecting(false);
    }
  };

  const update = (next: Automation) => state.setData(list.map((a) => (a.id === next.id ? next : a)));

  return (
    <div className={s.stack} data-testid="automation-coach">
      <div className={s.titleRow}>
        <span className={s.title}>
          <Beaker20Regular style={{ verticalAlign: "-4px", marginRight: "4px" }} />
          {t("automation.title")}
        </span>
        <Button size="small" appearance="outline" icon={detecting ? <Spinner size="extra-tiny" /> : <Search20Regular />} disabled={detecting} onClick={() => void detect()}>
          {t("automation.detectNow")}
        </Button>
      </div>

      {state.loading && !state.data && <Skeleton cards={2} />}
      {!!state.error && !state.data && <ErrorState error={state.error} onRetry={state.reload} />}

      {state.data && proposals.length === 0 && (
        <SectionCard tint="grey">
          <Text size={200}>{t("automation.noProposals")}</Text>
        </SectionCard>
      )}
      {proposals.map((a) => (
        <AutomationCard key={a.id} auto={a} onChange={update} />
      ))}

      {active.length > 0 && (
        <SectionCard title={t("automation.activeAutomations")} icon={<Checkmark20Regular />} iconColor={colors.lowText} iconBg={colors.lowBg}>
          {active.map((a, i) => (
            <div key={a.id} className={s.active} style={i === 0 ? { borderTop: "none", paddingTop: 0 } : undefined}>
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <strong>{a.name}</strong>
                <br />
                <span style={{ color: colors.textSecondary }}>{a.trigger.description}</span>
              </span>
              <span className={s.pill}>{t(`automation.status.${a.status}`)}</span>
              <span style={{ color: colors.textSecondary, whiteSpace: "nowrap" }}>{Math.round(a.stats.estimatedMinutesSavedPerWeek)} min/wk</span>
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  );
}

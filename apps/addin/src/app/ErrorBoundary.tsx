/**
 * Per-feature error boundary.
 *
 * A crash in Chat must not take down Summary, and a crash anywhere must not
 * leave the user staring at an empty pane. Each feature is wrapped in its own
 * boundary with a calm, localised recovery card:
 *
 *   - "Try again"  → remounts just that subtree (key bump), keeping the rest of
 *                    the pane, the loaded item and the language untouched
 *   - "Report"     → copies a small diagnostic block (correlation id, feature,
 *                    build, message — never mail content) to the clipboard so
 *                    the user can paste it into a ticket
 *
 * The boundary also emits one telemetry event per crash (name + feature only).
 */
import { Button, makeStyles, Text } from "@fluentui/react-components";
import { Checkmark16Regular, Copy16Regular, ErrorCircle24Regular } from "@fluentui/react-icons";
import { Component, useCallback, useState, type ErrorInfo, type ReactNode } from "react";
import { correlationIdOf } from "@/api/errors";
import { useI18n } from "@/i18n";
import { buildInfo } from "@/app/settings";
import { colors } from "@/ui/theme";
import { track } from "@/telemetry";

const useStyles = makeStyles({
  card: {
    backgroundColor: colors.card,
    border: `1px solid ${colors.highBorder}`,
    borderRadius: "8px",
    padding: "16px 14px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: "8px",
  },
  title: { fontWeight: 600, color: colors.text, fontSize: "14px" },
  body: { color: colors.textSecondary, fontSize: "13px", lineHeight: "18px" },
  detail: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "11px",
    color: colors.textSecondary,
    wordBreak: "break-word",
    backgroundColor: colors.background,
    borderRadius: "4px",
    paddingBlock: "6px",
    paddingInline: "8px",
    width: "100%",
    boxSizing: "border-box",
    textAlign: "start",
  },
  row: { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" },
});

export interface ErrorReport {
  feature: string;
  message: string;
  correlationId?: string;
  version: string;
  commit: string;
  at: string;
}

export function formatErrorReport(report: ErrorReport): string {
  return [
    "Outlook AI Orchestrator — error report",
    `feature:       ${report.feature}`,
    `correlationId: ${report.correlationId ?? "n/a"}`,
    `version:       ${report.version} (${report.commit})`,
    `at:            ${report.at}`,
    `message:       ${report.message}`,
  ].join("\n");
}

function FeatureErrorCard({ feature, error, onRetry }: { feature: string; error: unknown; onRetry: () => void }) {
  const s = useStyles();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const correlationId = correlationIdOf(error);
  const build = buildInfo();
  const report: ErrorReport = {
    feature,
    message: error instanceof Error ? error.message : String(error),
    correlationId,
    version: build.version,
    commit: build.commit,
    at: new Date().toISOString(),
  };

  const copy = useCallback(() => {
    const text = formatErrorReport(report);
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_500);
    };
    try {
      void navigator.clipboard?.writeText(text).then(done).catch(done);
    } catch {
      done();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.correlationId, report.message]);

  return (
    <div className={s.card} role="alert" data-testid="error-boundary" data-feature={feature}>
      <ErrorCircle24Regular style={{ color: colors.red }} aria-hidden="true" />
      <Text className={s.title}>{t("errors.boundaryTitle")}</Text>
      <Text className={s.body}>{t("errors.boundaryBody", { feature: t(`tabs.${feature}`) !== `tabs.${feature}` ? t(`tabs.${feature}`) : feature })}</Text>
      <div className={s.detail}>
        {t("errors.correlationId")}: {correlationId ?? "n/a"}
      </div>
      <div className={s.row}>
        <Button appearance="primary" size="small" onClick={onRetry} data-testid="error-retry">
          {t("app.retry")}
        </Button>
        <Button
          appearance="outline"
          size="small"
          icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
          onClick={copy}
          data-testid="error-report"
        >
          {copied ? t("errors.reportCopied") : t("errors.report")}
        </Button>
      </div>
    </div>
  );
}

interface Props {
  /** Used in the message and in telemetry (a tab key or a feature name). */
  feature: string;
  children: ReactNode;
  /** Custom fallback; the default card is used when omitted. */
  fallback?: (error: unknown, retry: () => void) => ReactNode;
}

interface State {
  error: unknown;
  /** Bumped on retry to remount the subtree. */
  key: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    track("ui.crash", { feature: this.props.feature }, { severity: "error", correlationId: correlationIdOf(error) });
    if (import.meta.env.DEV) console.error(`[oao] ${this.props.feature} crashed`, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, key: s.key + 1 }));
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
      return <FeatureErrorCard feature={this.props.feature} error={this.state.error} onRetry={this.retry} />;
    }
    return <div key={this.state.key} style={{ display: "contents" }}>{this.props.children}</div>;
  }
}

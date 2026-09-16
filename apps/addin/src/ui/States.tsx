import { Button, makeStyles, Skeleton as FluentSkeleton, SkeletonItem, Spinner, Text } from "@fluentui/react-components";
import { ErrorCircle24Regular, Mail24Regular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import { ApiClientError, correlationIdOf } from "@/api";
import { colors } from "./theme";

const useStyles = makeStyles({
  center: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "8px", padding: "24px 12px", color: colors.textSecondary },
  title: { fontWeight: 600, color: colors.text },
  skeleton: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 0" },
  progress: { display: "flex", alignItems: "center", gap: "8px", color: colors.textSecondary },
  correlation: { fontFamily: "Consolas, 'Courier New', monospace", fontSize: "11px", color: colors.textSecondary, wordBreak: "break-all" },
  card: { backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" },
});

export function EmptyState({ title, description, icon, action }: { title: ReactNode; description?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  const s = useStyles();
  return (
    <div className={s.center} role="status">
      {icon ?? <Mail24Regular />}
      <Text className={s.title}>{title}</Text>
      {description && <Text size={200}>{description}</Text>}
      {action}
    </div>
  );
}

/** Localised message for any error thrown by the API layer. */
export function useErrorMessage() {
  const { t } = useI18n();
  return (err: unknown): string => {
    if (err instanceof ApiClientError) return err.kind === "generic" ? t("errors.generic", { message: err.message }) : t(err.i18nKey);
    if (err instanceof Error) return t("errors.generic", { message: err.message });
    return t("errors.generic", { message: String(err) });
  };
}

/**
 * Inline failure of one section.
 *
 * It always names the correlation id when the backend gave us one: that id is
 * the only thing that ties what the user saw to the orchestrator log line, and
 * asking someone to "check the console" is not support.
 */
export function ErrorState({ error, onRetry, hint, retrying }: { error: unknown; onRetry?: () => void; hint?: ReactNode; retrying?: boolean }) {
  const s = useStyles();
  const { t } = useI18n();
  const msg = useErrorMessage();
  const correlationId = correlationIdOf(error);
  const status = error instanceof ApiClientError ? error.status : undefined;
  return (
    <div className={s.center} role="alert" data-testid="error-state" data-status={status ?? ""}>
      <ErrorCircle24Regular style={{ color: colors.red }} />
      <Text className={s.title}>{t("errors.title")}</Text>
      <Text size={200}>{msg(error)}</Text>
      {hint && <Text size={200}>{hint}</Text>}
      {correlationId && (
        <Text className={s.correlation} data-testid="error-correlation">
          {t("errors.correlationId")}: {correlationId}
        </Text>
      )}
      {onRetry && (
        <Button appearance="primary" size="small" onClick={onRetry} disabled={retrying} data-testid="error-retry">
          {retrying ? <Spinner size="extra-tiny" /> : t("app.retry")}
        </Button>
      )}
    </div>
  );
}

/**
 * Loading placeholder: `cards` stacked cards with a few lines each.
 *
 * `label` is the progress text ("Analysing this email…"); the *subject* of the
 * item being worked on is rendered above it by the surface itself, so every
 * loading state says which email the pane is busy with.
 */
export function Skeleton({ cards = 3, label }: { cards?: number; label?: string }) {
  const s = useStyles();
  return (
    <FluentSkeleton aria-label={label ?? "loading"} className={s.skeleton} data-testid="skeleton">
      {label && (
        <div className={s.progress} data-testid="skeleton-label">
          <Spinner size="extra-tiny" />
          <Text size={200}>{label}</Text>
        </div>
      )}
      {Array.from({ length: cards }, (_, i) => (
        <div key={i} className={s.card}>
          <SkeletonItem size={16} style={{ width: "40%" }} />
          <SkeletonItem size={12} />
          <SkeletonItem size={12} style={{ width: "85%" }} />
          <SkeletonItem size={12} style={{ width: "60%" }} />
        </div>
      ))}
    </FluentSkeleton>
  );
}

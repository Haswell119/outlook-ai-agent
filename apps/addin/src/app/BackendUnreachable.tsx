/**
 * The blocking state shown when the startup health check fails **inside an
 * Outlook host** (read, compose, pinned, multi-select or the Apps-rail home
 * surface).
 *
 * It exists because the alternative used to be worse: a dev build whose
 * `VITE_API_BASE_URL` pointed nowhere silently fell back to the mock client, so
 * the pane happily summarised — and drafted replies from — the built-in sample
 * email while the user was reading a real one. Sample data about someone's
 * mailbox is not a degraded mode, it is a wrong answer, so the pane says what
 * is broken, where it tried to connect, and offers Retry.
 */
import { Button, makeStyles, Spinner, Text } from "@fluentui/react-components";
import { ArrowSync20Regular, PlugDisconnected24Regular } from "@fluentui/react-icons";
import { useI18n } from "@/i18n";
import { SectionCard, colors, useErrorMessage } from "@/ui";
import { Header } from "./Header";

const useStyles = makeStyles({
  content: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: colors.background },
  row: { display: "flex", gap: "10px", alignItems: "flex-start" },
  body: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },
  url: { fontFamily: "Consolas, 'Courier New', monospace", fontSize: "12px", wordBreak: "break-all", color: colors.text },
  detail: { color: colors.textSecondary, fontSize: "12px", wordBreak: "break-word" },
  actions: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "4px" },
});

export interface BackendUnreachableProps {
  baseUrl: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

export function BackendUnreachable({ baseUrl, error, retrying, onRetry }: BackendUnreachableProps) {
  const s = useStyles();
  const { t } = useI18n();
  const errMsg = useErrorMessage();
  return (
    <>
      <Header subtitle={t("errors.backendTitle")} />
      <main className={s.content} id="oao-main" tabIndex={-1} data-testid="backend-unreachable">
        <SectionCard tint="red" testId="backend-unreachable-card">
          <div className={s.row} role="alert">
            <PlugDisconnected24Regular style={{ color: colors.red, flexShrink: 0 }} aria-hidden="true" />
            <div className={s.body}>
              <Text weight="semibold" size={400}>
                {t("errors.backendTitle")}
              </Text>
              <Text size={300}>{t("errors.backendBody")}</Text>
              <Text className={s.url} data-testid="backend-unreachable-url">
                {baseUrl}
              </Text>
              <Text size={200} className={s.detail}>
                {t("errors.backendHint")}
              </Text>
              <Text size={200} className={s.detail} data-testid="backend-unreachable-detail">
                {t("errors.backendDetail", { message: errMsg(error) })}
              </Text>
              <div className={s.actions}>
                <Button
                  appearance="primary"
                  size="small"
                  icon={retrying ? <Spinner size="extra-tiny" /> : <ArrowSync20Regular />}
                  onClick={onRetry}
                  disabled={retrying}
                  data-testid="backend-retry"
                >
                  {t("app.retry")}
                </Button>
              </div>
            </div>
          </div>
        </SectionCard>
      </main>
    </>
  );
}

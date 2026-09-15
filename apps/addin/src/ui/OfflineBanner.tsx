/**
 * Non-blocking connectivity banner.
 *
 * It never covers content, never steals focus and never disables anything: the
 * cached analyses stay readable offline and any action the user takes is either
 * queued (observations) or fails with its own inline error. `role="status"` +
 * `aria-live="polite"` so a screen reader hears it after the current sentence,
 * not in the middle of one.
 */
import { Button, makeStyles } from "@fluentui/react-components";
import { CloudOff20Regular, PlugDisconnected20Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { connectivity, onConnectivityChange, type Connectivity } from "@/net/connectivity";
import { size as outboxSize } from "@/net/outbox";
import { colors } from "./theme";

const useStyles = makeStyles({
  banner: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    paddingBlock: "8px",
    paddingInline: "12px",
    backgroundColor: colors.mediumBg,
    color: colors.mediumText,
    borderBottom: `1px solid ${colors.mediumBorder}`,
    fontSize: "12px",
    lineHeight: "16px",
  },
  text: { flexGrow: 1, minWidth: 0 },
  icon: { display: "inline-flex", flexShrink: 0 },
});

export function useConnectivity(): Connectivity {
  const [state, setState] = useState<Connectivity>(() => connectivity());
  useEffect(() => onConnectivityChange(setState), []);
  return state;
}

export function OfflineBanner({ onRetry }: { onRetry?: () => void }) {
  const s = useStyles();
  const { t } = useI18n();
  const state = useConnectivity();
  if (state === "online") return null;

  const queued = outboxSize();
  const message = state === "offline" ? t("app.offline") : t("app.backendUnreachable");

  return (
    <div className={s.banner} role="status" aria-live="polite" data-testid="offline-banner" data-state={state}>
      <span className={s.icon} aria-hidden="true">
        {state === "offline" ? <CloudOff20Regular /> : <PlugDisconnected20Regular />}
      </span>
      <span className={s.text}>
        {message}
        {queued > 0 ? ` ${t("app.queuedEvents", { count: queued })}` : ""}
      </span>
      {onRetry && (
        <Button size="small" appearance="transparent" onClick={onRetry}>
          {t("app.retry")}
        </Button>
      )}
    </div>
  );
}

import { Button, makeStyles, Text, Tooltip } from "@fluentui/react-components";
import { ThumbDislike16Regular, ThumbDislike16Filled, ThumbLike16Regular, ThumbLike16Filled } from "@fluentui/react-icons";
import { useState } from "react";
import { getApi } from "@/api";
import { useI18n } from "@/i18n";
import { ConfidenceBar } from "./ConfidenceBar";
import { colors } from "./theme";
import { useToast } from "./toast";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "8px", paddingTop: "4px" },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  disclaimer: { color: colors.textSecondary, fontSize: "12px" },
  thumbs: { display: "flex", gap: "2px" },
});

export interface AiFooterProps {
  auditId?: string;
  /** When given, an "AI confidence" bar is rendered above the disclaimer. */
  confidence?: number;
  extra?: React.ReactNode;
}

export function AiFooter({ auditId, confidence, extra }: AiFooterProps) {
  const s = useStyles();
  const { t } = useI18n();
  const toast = useToast();
  const [rating, setRating] = useState<"up" | "down" | null>(null);

  const send = async (r: "up" | "down") => {
    setRating(r);
    if (!auditId) return;
    try {
      await getApi().feedback({ auditId, rating: r });
      toast.success(t("footer.feedbackSent"));
    } catch {
      /* feedback is best-effort */
    }
  };

  return (
    <div className={s.root} data-testid="ai-footer">
      {confidence !== undefined && <ConfidenceBar value={confidence} />}
      <div className={s.row}>
        <Text className={s.disclaimer}>{t("footer.disclaimer")}</Text>
        <div className={s.thumbs}>
          {extra}
          <Tooltip content={t("footer.thumbsUp")} relationship="label">
            <Button size="small" appearance="subtle" icon={rating === "up" ? <ThumbLike16Filled /> : <ThumbLike16Regular />} onClick={() => void send("up")} aria-pressed={rating === "up"} />
          </Tooltip>
          <Tooltip content={t("footer.thumbsDown")} relationship="label">
            <Button size="small" appearance="subtle" icon={rating === "down" ? <ThumbDislike16Filled /> : <ThumbDislike16Regular />} onClick={() => void send("down")} aria-pressed={rating === "down"} />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

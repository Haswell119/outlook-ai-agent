"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, PauseCircle, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { readApiError, useToast } from "@/components/ui/toast";
import { tr, type Messages } from "@/lib/i18n";

export type DecisionKind = "approve" | "reject" | "pause" | "resume";

const ICONS: Record<DecisionKind, React.ComponentType<{ className?: string }>> = {
  approve: Check,
  reject: X,
  pause: PauseCircle,
  resume: Play,
};

/**
 * Comment dialog shared by the escalation and automation decisions.
 *
 * `endpoint` is a route handler under `/api/*` that re-checks the role and
 * proxies the orchestrator. A rejection always requires a justification
 * (`requireComment`), enforced here for immediate feedback and again in the
 * route handler, which is the authority.
 */
export function DecisionDialog({
  endpoint,
  body,
  kind,
  title,
  description,
  triggerLabel,
  messages,
  disabled,
  iconOnly = false,
  requireComment = false,
  successMessage,
  onOptimistic,
  onRevert,
}: {
  endpoint: string;
  body: Record<string, unknown>;
  kind: DecisionKind;
  title: string;
  description: string;
  triggerLabel: string;
  messages: Messages;
  disabled?: boolean;
  /** Icon-only trigger, for dense table rows. */
  iconOnly?: boolean;
  requireComment?: boolean;
  successMessage?: string;
  /** Applied immediately, before the round-trip. */
  onOptimistic?: () => void;
  /** Called when the request failed, to undo the optimistic update. */
  onRevert?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();
  const t = (k: string, vars?: Record<string, string | number>) => tr(messages, k, vars);
  const Icon = ICONS[kind];

  const submit = async () => {
    const trimmed = comment.trim();
    if (requireComment && trimmed.length === 0) {
      setError(t("approvals.commentRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    onOptimistic?.();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, comment: trimmed || undefined }),
      });
      if (!res.ok) {
        const payload = await readApiError(res);
        onRevert?.();
        setError(payload.message);
        toast({
          title: t("toast.failed"),
          description: payload.message,
          correlationId: payload.correlationId,
          tone: "error",
          onRetry: () => void submit(),
        });
        return;
      }
      setOpen(false);
      setComment("");
      toast({ title: successMessage ?? t("toast.saved"), tone: "success" });
      router.refresh();
    } catch (e) {
      onRevert?.();
      const message = e instanceof Error ? e.message : t("toast.failed");
      setError(message);
      toast({ title: t("toast.failed"), description: message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={kind === "approve" && !iconOnly ? "default" : "outline"}
        size={iconOnly ? "icon-sm" : "sm"}
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={iconOnly ? triggerLabel : undefined}
        title={iconOnly ? triggerLabel : undefined}
        className={
          kind === "reject" ? "border-[#C4314B]/40 text-[#C4314B] hover:bg-[#FDE7E9]" : undefined
        }
      >
        <Icon
          className={
            kind === "approve" && iconOnly ? "h-4 w-4 text-[#107C10]" : "h-4 w-4"
          }
          aria-hidden="true"
        />
        {!iconOnly && triggerLabel}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`decision-comment-${kind}`}>
            {t("approvals.comment")}
            {requireComment && <span aria-hidden="true"> *</span>}
          </Label>
          <Textarea
            id={`decision-comment-${kind}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("approvals.commentPlaceholder")}
            required={requireComment}
            aria-required={requireComment}
            aria-invalid={error ? true : undefined}
            aria-describedby={`decision-comment-hint-${kind}`}
          />
          <p id={`decision-comment-hint-${kind}`} className="text-xs text-[#616161]">
            {t("approvals.commentOptional")}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-xs font-medium text-[#C4314B]">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {busy ? t("approvals.saving") : t("approvals.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

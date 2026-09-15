"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, PauseCircle, X } from "lucide-react";
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

export type DecisionKind = "approve" | "reject" | "pause";

/**
 * Comment dialog shared by the escalation and automation decisions.
 * `endpoint` is a route handler under /api/* that proxies the orchestrator.
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
}: {
  endpoint: string;
  body: Record<string, unknown>;
  kind: DecisionKind;
  title: string;
  description: string;
  triggerLabel: string;
  messages: Record<string, string>;
  disabled?: boolean;
  /** Icon-only trigger, for dense table rows. */
  iconOnly?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const t = (k: string) => messages[k] ?? k;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, comment: comment || undefined }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Request failed (${res.status})`);
      }
      setOpen(false);
      setComment("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
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
        {kind === "approve" ? (
          <Check className={iconOnly ? "h-4 w-4 text-[#107C10]" : "h-4 w-4"} />
        ) : kind === "reject" ? (
          <X className="h-4 w-4" />
        ) : (
          <PauseCircle className="h-4 w-4" />
        )}
        {!iconOnly && triggerLabel}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="decision-comment">{t("approvals.comment")}</Label>
          <Textarea
            id="decision-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("approvals.commentPlaceholder")}
          />
        </div>
        {error && <p className="text-xs font-medium text-[#C4314B]">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("approvals.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

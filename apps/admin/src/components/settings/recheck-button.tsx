"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readApiError, useToast } from "@/components/ui/toast";
import { tr, type Messages } from "@/lib/i18n";

export function RecheckButton({ label, messages }: { label: string; messages: Messages }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) {
        const err = await readApiError(res);
        toast({
          title: tr(messages, "error.title"),
          description: err.message,
          correlationId: err.correlationId,
          tone: "error",
          onRetry: () => void run(),
        });
        return;
      }
      router.refresh();
    } catch (e) {
      toast({
        title: tr(messages, "toast.failed"),
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
      )}
      {label}
    </Button>
  );
}

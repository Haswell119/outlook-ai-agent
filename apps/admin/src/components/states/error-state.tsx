"use client";

import * as React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { dictionaries, tr, type Messages } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shared body of every `error.tsx`. Error boundaries receive no props from the
 * server, so the language is read from `<html lang>` (set by the root layout)
 * and the flat dictionary is looked up on the client.
 */
export function ErrorState({
  error,
  reset,
  correlationId,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  correlationId?: string;
}) {
  const [messages, setMessages] = React.useState<Messages>(dictionaries.en as Messages);

  React.useEffect(() => {
    const lang = document.documentElement.lang;
    setMessages((lang === "fr" ? dictionaries.fr : dictionaries.en) as Messages);
    console.error("[@oao/admin]", error);
  }, [error]);

  const trace = correlationId ?? error.digest;

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#FDE7E9] text-[#C4314B]">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </span>
        <CardTitle className="text-base">{tr(messages, "error.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[#424242]">{tr(messages, "error.body")}</p>
        <p className="break-words rounded-md bg-[#FAF9F8] px-3 py-2 font-mono text-xs text-[#616161]">
          {error.message}
        </p>
        {trace && (
          <p className="break-all font-mono text-xs text-[#616161]">
            {tr(messages, "error.correlationId")}: {trace}
          </p>
        )}
        {reset && (
          <Button onClick={reset}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            {tr(messages, "action.retry")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

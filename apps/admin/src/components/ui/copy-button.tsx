"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies `value` to the clipboard; falls back silently when denied. */
export function CopyButton({
  value,
  label,
  copiedLabel,
  iconOnly = false,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (insecure context / denied) */
    }
  };

  return (
    <Button
      variant="outline"
      size={iconOnly ? "icon-sm" : "sm"}
      onClick={() => void copy()}
      aria-label={iconOnly ? (copied ? copiedLabel : label) : undefined}
      title={iconOnly ? (copied ? copiedLabel : label) : undefined}
    >
      {copied ? (
        <Check className="h-4 w-4 text-[#107C10]" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {!iconOnly && (copied ? copiedLabel : label)}
    </Button>
  );
}

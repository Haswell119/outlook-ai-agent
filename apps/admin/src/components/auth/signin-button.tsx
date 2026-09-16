"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Starts the Entra ID authorization-code flow. */
export function SignInButton({
  callbackUrl,
  label,
  children,
}: {
  callbackUrl: string;
  label: string;
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      className="w-full"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signIn("microsoft-entra-id", { callbackUrl });
      }}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : children}
      {label}
    </Button>
  );
}

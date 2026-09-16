"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SignOutButton({
  label,
  variant = "outline",
}: {
  label: string;
  variant?: "outline" | "ghost";
}) {
  return (
    <Button variant={variant} onClick={() => void signOut({ callbackUrl: "/signin" })}>
      <LogOut className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

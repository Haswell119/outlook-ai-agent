"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Bell,
  ChevronDown,
  CircleHelp,
  Database,
  LogOut,
  Settings,
  ShieldAlert,
  User,
} from "lucide-react";
import type { Language } from "@oao/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { primaryRole, type AdminRole } from "@/lib/rbac";
import { useToast } from "@/components/ui/toast";

export interface TopBarProps {
  organisation: string;
  language: Language;
  mock: boolean;
  pendingApprovals: number;
  messages: Record<string, string>;
  user: { email: string; name: string; roles: AdminRole[] };
  authMode: "aad" | "token";
  sessionExpired: boolean;
}

function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function TopBar({
  organisation,
  language,
  mock,
  pendingApprovals,
  messages,
  user,
  authMode,
  sessionExpired,
}: TopBarProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const { toast } = useToast();
  const t = (key: string) => messages[key] ?? key;
  const role = primaryRole(user.roles);

  React.useEffect(() => {
    if (sessionExpired) {
      toast({
        title: t("auth.sessionExpired"),
        description: t("auth.sessionExpiredHint"),
        tone: "error",
        duration: 0,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionExpired]);

  const switchLanguage = async (next: Language) => {
    if (next === language) return;
    setPending(true);
    try {
      const res = await fetch("/api/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      toast({ title: t("toast.failed"), tone: "error" });
    } finally {
      setPending(false);
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-[#E1DFDD] bg-white px-4 lg:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {mock && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="medium" className="gap-1.5 border border-[#8A6D00]/30 px-2.5 py-1">
                  <Database className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("top.mock")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("top.mockHint")}</TooltipContent>
            </Tooltip>
          )}
          {sessionExpired && (
            <Badge variant="high" className="gap-1.5 px-2.5 py-1">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              {t("auth.sessionExpired")}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div
            className="mr-1 flex overflow-hidden rounded-md border border-[#E1DFDD]"
            role="group"
            aria-label={t("action.language")}
          >
            {(["en", "fr"] as Language[]).map((lng) => (
              <button
                key={lng}
                type="button"
                disabled={pending}
                onClick={() => void switchLanguage(lng)}
                aria-pressed={language === lng}
                className={
                  language === lng
                    ? "bg-brand px-2.5 py-1 text-xs font-semibold uppercase text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    : "px-2.5 py-1 text-xs font-semibold uppercase text-[#616161] hover:bg-[#F3F2F1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                }
              >
                {lng}
              </button>
            ))}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("top.settings")}
                onClick={() => router.push("/settings")}
              >
                <Settings className="h-4 w-4 text-[#616161]" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("top.settings")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("top.help")}
                onClick={() => router.push("/roles")}
              >
                <CircleHelp className="h-4 w-4 text-[#616161]" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("top.help")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative"
                aria-label={`${t("top.notifications")} (${pendingApprovals})`}
                onClick={() => router.push("/approvals")}
              >
                <Bell className="h-4 w-4 text-[#616161]" aria-hidden="true" />
                {pendingApprovals > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#C4314B] px-1 text-[10px] font-bold text-white">
                    {pendingApprovals}
                  </span>
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("top.notifications")}</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="ml-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-[#242424] hover:bg-[#F3F2F1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy text-[11px] font-bold text-white">
                  {initials(user.name, user.email)}
                </span>
                <span className="hidden max-w-[16ch] truncate lg:inline">{organisation}</span>
                <ChevronDown className="h-3.5 w-3.5 text-[#616161]" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>{organisation}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled>
                <User className="h-4 w-4" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate">{user.name}</span>
                  <span className="block truncate text-xs text-[#616161]">{user.email}</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <span className="text-xs text-[#616161]">
                  {t("auth.role")}: {t(`role.${role}`)}
                  {authMode === "token" ? ` · ${t("auth.tokenMode")}` : ""}
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/settings")}>
                <Settings className="h-4 w-4" aria-hidden="true" /> {t("nav.settings")}
              </DropdownMenuItem>
              {authMode === "aad" && (
                <DropdownMenuItem onSelect={() => void signOut({ callbackUrl: "/signin" })}>
                  <LogOut className="h-4 w-4" aria-hidden="true" /> {t("auth.signOut")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    </TooltipProvider>
  );
}

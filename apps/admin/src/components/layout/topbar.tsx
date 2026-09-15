"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, CircleHelp, Database, Settings, User } from "lucide-react";
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

export interface TopBarProps {
  tenantName: string;
  language: Language;
  mock: boolean;
  pendingApprovals: number;
  messages: Record<string, string>;
}

export function TopBar({ tenantName, language, mock, pendingApprovals, messages }: TopBarProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const t = (key: string) => messages[key] ?? key;

  const switchLanguage = async (next: Language) => {
    if (next === language) return;
    setPending(true);
    try {
      await fetch("/api/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
      router.refresh();
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
                <Badge variant="medium" className="gap-1.5 border border-[#F2C94C]/60 px-2.5 py-1">
                  <Database className="h-3.5 w-3.5" />
                  {t("top.mock")}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("top.mockHint")}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div className="mr-1 flex overflow-hidden rounded-md border border-[#E1DFDD]" role="group" aria-label={t("action.language")}>
            {(["en", "fr"] as Language[]).map((lng) => (
              <button
                key={lng}
                type="button"
                disabled={pending}
                onClick={() => void switchLanguage(lng)}
                aria-pressed={language === lng}
                className={
                  language === lng
                    ? "bg-brand px-2.5 py-1 text-xs font-semibold uppercase text-white"
                    : "px-2.5 py-1 text-xs font-semibold uppercase text-[#616161] hover:bg-[#F3F2F1]"
                }
              >
                {lng}
              </button>
            ))}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("top.settings")} onClick={() => router.push("/settings")}>
                <Settings className="h-4 w-4 text-[#616161]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("top.settings")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("top.help")} onClick={() => router.push("/roles")}>
                <CircleHelp className="h-4 w-4 text-[#616161]" />
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
                aria-label={t("top.notifications")}
                onClick={() => router.push("/approvals")}
              >
                <Bell className="h-4 w-4 text-[#616161]" />
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
              <button className="ml-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-[#242424] hover:bg-[#F3F2F1]">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-navy text-[11px] font-bold text-white">
                  JS
                </span>
                <span className="hidden truncate lg:inline">{tenantName}</span>
                <ChevronDown className="h-3.5 w-3.5 text-[#616161]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>{tenantName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/users")}>
                <User className="h-4 w-4" /> Jane Smith · admin
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push("/settings")}>
                <Settings className="h-4 w-4" /> {t("nav.settings")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
    </TooltipProvider>
  );
}

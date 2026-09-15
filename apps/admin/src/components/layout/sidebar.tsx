"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BookLock,
  CheckSquare,
  Gauge,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Timer,
  TrendingUp,
  Users,
  Wand2,
} from "lucide-react";
import { NAV_GROUPS, type NavItem } from "./nav";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MessageKey } from "@/lib/i18n";

const ICONS: Record<NavItem["icon"], React.ComponentType<{ className?: string }>> = {
  gauge: Gauge,
  shield: Shield,
  check: CheckSquare,
  alert: AlertTriangle,
  wand: Wand2,
  book: BookLock,
  trend: TrendingUp,
  timer: Timer,
  sparkles: Sparkles,
  users: Users,
  key: KeyRound,
  plug: Plug,
  settings: Settings,
};

const STORAGE_KEY = "oao.sidebar.collapsed";

export function Sidebar({ messages }: { messages: Record<string, string> }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* private mode */
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const t = (key: MessageKey | string) => messages[key] ?? key;
  const currentTab = searchParams.get("tab");

  const isActive = (href: string) => {
    const [path, query] = href.split("?");
    if (path !== pathname) return false;
    if (!query) return true;
    const tab = new URLSearchParams(query).get("tab");
    return tab === (currentTab ?? "usage");
  };

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        data-collapsed={collapsed}
        className={cn(
          "sticky top-0 flex h-screen shrink-0 flex-col bg-navy text-white transition-[width] duration-200",
          collapsed ? "w-[68px]" : "w-[248px]",
        )}
      >
        <div className={cn("flex items-center gap-2.5 px-4 py-4", collapsed && "justify-center px-2")}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand">
            <ShieldCheck className="h-5 w-5" />
          </span>
          {!collapsed && (
            <span className="text-sm font-semibold leading-tight">
              Outlook AI
              <br />
              <span className="text-navy-300">Orchestrator</span>
            </span>
          )}
        </div>

        <nav className="oao-scroll flex-1 overflow-y-auto px-2 pb-2">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.labelKey ?? `g-${gi}`} className="mb-3">
              {group.labelKey && !collapsed && (
                <p className="px-2 pb-1.5 pt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-navy-300">
                  {t(group.labelKey)}
                </p>
              )}
              {group.labelKey && collapsed && <div className="mx-2 mb-2 mt-2 h-px bg-white/10" />}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const active = isActive(item.href);
                  const link = (
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] font-medium transition-colors",
                        active ? "bg-brand text-white" : "text-white/85 hover:bg-white/10",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {!collapsed && <span className="truncate">{t(item.labelKey)}</span>}
                    </Link>
                  );
                  return (
                    <li key={item.href}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          <TooltipContent side="right">{t(item.labelKey)}</TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <button
          type="button"
          onClick={toggle}
          className={cn(
            "m-2 flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] font-medium text-white/80 transition-colors hover:bg-white/10",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          {!collapsed && <span>{t("nav.collapse")}</span>}
        </button>
      </aside>
    </TooltipProvider>
  );
}

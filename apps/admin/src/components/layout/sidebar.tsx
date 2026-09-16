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
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Timer,
  TrendingUp,
  Users,
  Wand2,
} from "lucide-react";
import { visibleNavGroups, type NavItem } from "./nav";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AdminRole } from "@/lib/rbac";
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
  server: Server,
  settings: Settings,
};

const STORAGE_KEY = "oao.sidebar.collapsed";
const APPROVALS_POLL_MS = 30_000;

export function Sidebar({
  messages,
  roles,
  pendingApprovals,
}: {
  messages: Record<string, string>;
  roles: AdminRole[];
  /** Server-rendered seed; refreshed every 30 s from `/api/approvals/pending`. */
  pendingApprovals: number;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = React.useState(false);
  const [pending, setPending] = React.useState(pendingApprovals);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* private mode */
    }
  }, []);

  React.useEffect(() => setPending(pendingApprovals), [pendingApprovals]);

  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/approvals/pending", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { pending?: number };
        if (!cancelled && typeof body.pending === "number") setPending(body.pending);
      } catch {
        /* keep the last known value */
      }
    };
    const id = window.setInterval(() => void tick(), APPROVALS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
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
  const groups = React.useMemo(() => visibleNavGroups(roles), [roles]);

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
          "sticky top-0 flex h-screen shrink-0 flex-col bg-navy text-white motion-safe:transition-[width] motion-safe:duration-200",
          // Always icons-only below `lg`: 248 px of navigation would leave a
          // phone with no room for the content.
          collapsed ? "w-[68px]" : "w-[68px] lg:w-[248px]",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2.5 px-4 py-4 max-lg:justify-center max-lg:px-2",
            collapsed && "justify-center px-2",
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          {!collapsed && (
            <span className="hidden text-sm font-semibold leading-tight lg:block">
              Outlook AI
              <br />
              <span className="text-navy-300">Orchestrator</span>
            </span>
          )}
        </div>

        <nav aria-label={t("nav.group.supervision")} className="oao-scroll flex-1 overflow-y-auto px-2 pb-2">
          {groups.map((group, gi) => (
            <div key={group.labelKey ?? `g-${gi}`} className="mb-3">
              {group.labelKey && !collapsed && (
                <>
                  <p className="hidden px-2 pb-1.5 pt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-navy-300 lg:block">
                    {t(group.labelKey)}
                  </p>
                  <div className="mx-2 mb-2 mt-2 h-px bg-white/10 lg:hidden" />
                </>
              )}
              {group.labelKey && collapsed && <div className="mx-2 mb-2 mt-2 h-px bg-white/10" />}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const active = isActive(item.href);
                  const showBadge = item.badge === "approvals" && pending > 0;
                  const link = (
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] font-medium motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-navy",
                        active ? "bg-brand text-white" : "text-white/85 hover:bg-white/10",
                        "max-lg:justify-center max-lg:px-0",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <span className="relative flex shrink-0 items-center">
                        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {showBadge && (
                          <span
                            className={cn(
                              "absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-[#C4314B]",
                              collapsed ? "" : "lg:hidden",
                            )}
                          />
                        )}
                      </span>
                      {!collapsed && (
                        <span className="hidden truncate lg:inline">{t(item.labelKey)}</span>
                      )}
                      {!collapsed && showBadge && (
                        <span
                          className="ml-auto hidden h-4 min-w-4 items-center justify-center rounded-full bg-[#C4314B] px-1 text-[10px] font-bold text-white lg:flex"
                          aria-label={(messages["approvals.pendingBadge"] ?? "{count} pending").replace(
                            "{count}",
                            String(pending),
                          )}
                        >
                          {pending}
                        </span>
                      )}
                    </Link>
                  );
                  return (
                    <li key={item.href}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          <TooltipContent side="right">
                            {t(item.labelKey)}
                            {showBadge ? ` (${pending})` : ""}
                          </TooltipContent>
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
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          className={cn(
            "m-2 flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] font-medium text-white/80 motion-safe:transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-navy max-lg:hidden",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
          {!collapsed && <span className="hidden lg:inline">{t("nav.collapse")}</span>}
        </button>
      </aside>
    </TooltipProvider>
  );
}

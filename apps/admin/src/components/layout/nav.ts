import type { MessageKey } from "@/lib/i18n";

export interface NavItem {
  href: string;
  labelKey: MessageKey;
  icon:
    | "gauge"
    | "shield"
    | "check"
    | "alert"
    | "wand"
    | "book"
    | "trend"
    | "timer"
    | "sparkles"
    | "users"
    | "key"
    | "plug"
    | "settings";
}

export interface NavGroup {
  labelKey?: MessageKey;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  { items: [{ href: "/", labelKey: "nav.overview", icon: "gauge" }] },
  {
    labelKey: "nav.group.supervision",
    items: [
      { href: "/audit", labelKey: "nav.audit", icon: "shield" },
      { href: "/approvals", labelKey: "nav.approvals", icon: "check" },
      { href: "/alerts", labelKey: "nav.alerts", icon: "alert" },
      { href: "/automations", labelKey: "nav.automations", icon: "wand" },
      { href: "/policy", labelKey: "nav.policy", icon: "book" },
    ],
  },
  {
    labelKey: "nav.group.analytics",
    items: [
      { href: "/analytics?tab=usage", labelKey: "nav.usage", icon: "trend" },
      { href: "/analytics?tab=performance", labelKey: "nav.performance", icon: "timer" },
      { href: "/analytics?tab=impact", labelKey: "nav.impact", icon: "sparkles" },
    ],
  },
  {
    labelKey: "nav.group.administration",
    items: [
      { href: "/users", labelKey: "nav.users", icon: "users" },
      { href: "/roles", labelKey: "nav.roles", icon: "key" },
      { href: "/integrations", labelKey: "nav.integrations", icon: "plug" },
      { href: "/settings", labelKey: "nav.settings", icon: "settings" },
    ],
  },
];

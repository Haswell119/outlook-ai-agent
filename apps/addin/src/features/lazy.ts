/**
 * Feature code-splitting.
 *
 * Only the Summary path is in the main chunk. Chat, Insights (+ Automation
 * Coach), Compliance Guardian, the Daily brief and the Settings sheet are
 * separate chunks loaded on demand, which is what keeps the first paint of the
 * pane under the bundle budget (see README "Bundle budget").
 *
 * `prefetch*()` is called on tab **hover / focus** (and on idle for the tab the
 * user is most likely to open next), so by the time the click lands the chunk
 * is usually already in the HTTP cache — the lazy boundary then resolves
 * synchronously and there is no visible suspense flash.
 */
import { lazy } from "react";

const chatImport = () => import("./chat/ChatTab");
const insightsImport = () => import("./insights/InsightsTab");
const complianceImport = () => import("./compliance/ComplianceGuardian");
const briefImport = () => import("./brief/DailyBriefView");
const settingsImport = () => import("./settings/SettingsSheet");
const approvalImport = () => import("./actions/ActionApprovalDialog");
const threadImport = () => import("./thread/ThreadView");
const selectionImport = () => import("./selection/SelectionView");
const syncImport = () => import("./insights/SyncStatusPill");

export const LazyChatTab = lazy(() => chatImport().then((m) => ({ default: m.ChatTab })));
export const LazyInsightsTab = lazy(() => insightsImport().then((m) => ({ default: m.InsightsTab })));
export const LazyComplianceGuardian = lazy(() => complianceImport().then((m) => ({ default: m.ComplianceGuardian })));
export const LazyDailyBriefView = lazy(() => briefImport().then((m) => ({ default: m.DailyBriefView })));
export const LazySettingsSheet = lazy(() => settingsImport().then((m) => ({ default: m.SettingsSheet })));
export const LazyActionApprovalDialog = lazy(() => approvalImport().then((m) => ({ default: m.ActionApprovalDialog })));
export const LazyThreadView = lazy(() => threadImport().then((m) => ({ default: m.ThreadView })));
export const LazySelectionView = lazy(() => selectionImport().then((m) => ({ default: m.SelectionView })));
export const LazySyncStatusPill = lazy(() => syncImport().then((m) => ({ default: m.SyncStatusPill })));

const started = new Set<string>();

function prefetch(key: string, load: () => Promise<unknown>): void {
  if (started.has(key)) return;
  started.add(key);
  void load().catch(() => started.delete(key));
}

export const prefetchChat = () => prefetch("chat", chatImport);
export const prefetchInsights = () => prefetch("insights", insightsImport);
export const prefetchCompliance = () => prefetch("compliance", complianceImport);
export const prefetchBrief = () => prefetch("brief", briefImport);
export const prefetchSettings = () => prefetch("settings", settingsImport);
export const prefetchApproval = () => prefetch("approval", approvalImport);
export const prefetchThread = () => prefetch("thread", threadImport);
export const prefetchSelection = () => prefetch("selection", selectionImport);

/** Map a tab key to its prefetcher (used by the TabList hover handlers). */
export const PREFETCH_BY_TAB: Record<string, () => void> = {
  chat: prefetchChat,
  insights: prefetchInsights,
  brief: prefetchBrief,
  summary: prefetchThread,
};

/**
 * Warm the chunks the user is most likely to need, once the pane is idle and
 * the first analysis has rendered. Never on a metered/slow connection.
 */
export function prefetchWhenIdle(): void {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } };
  if (nav.connection?.saveData) return;
  if (nav.connection?.effectiveType && /2g/.test(nav.connection.effectiveType)) return;
  const run = () => {
    prefetchApproval();
    prefetchThread();
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4_000 });
  else setTimeout(run, 2_000);
}

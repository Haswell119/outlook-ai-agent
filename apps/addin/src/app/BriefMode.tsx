/**
 * The **"Daily brief" ribbon button** (`?view=brief`): the brief on its own,
 * whatever is selected. It is already precomputed, so it is instant.
 *
 * The pane opened with *nothing* selected renders `HomeMode` instead (brief +
 * chat over the mailbox) — see `office/host.ts`.
 */
import { makeStyles } from "@fluentui/react-components";
import { Suspense } from "react";
import { useI18n } from "@/i18n";
import { LazyDailyBriefView } from "@/features/lazy";
import { Skeleton, colors } from "@/ui";
import { ErrorBoundary } from "./ErrorBoundary";
import { Header } from "./Header";

const useStyles = makeStyles({
  content: { padding: "12px", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: colors.background },
});

export function BriefMode() {
  const s = useStyles();
  const { t } = useI18n();
  return (
    <>
      <Header subtitle={t("brief.title")} />
      <main className={s.content} id="oao-main" tabIndex={-1} data-testid="brief-mode">
        <ErrorBoundary feature="brief">
          <Suspense fallback={<Skeleton cards={4} label={t("brief.loading")} />}>
            <LazyDailyBriefView />
          </Suspense>
        </ErrorBoundary>
      </main>
    </>
  );
}

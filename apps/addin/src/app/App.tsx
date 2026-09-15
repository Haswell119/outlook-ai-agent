import { FluentProvider, makeStyles, webLightTheme } from "@fluentui/react-components";
import { useEffect, useMemo, useState } from "react";
import { initApi, getApi, setLanguageGetter, type OaoApi } from "@/api";
import { I18nProvider, useI18n } from "@/i18n";
import { isComposeMode, isPreviewMode, queryParam } from "@/office/env";
import { ToastProvider } from "@/ui/toast";
import { colors } from "@/ui/theme";
import { AppContext, adminUrl, complianceEmail } from "./AppContext";
import { ReadMode } from "./ReadMode";
import { ComplianceGuardian } from "@/features/compliance/ComplianceGuardian";

const useStyles = makeStyles({
  // NOTE: FluentProvider copies its className onto portal mount nodes (tooltips, toasts),
  // so page-level layout styles live on an inner wrapper, never on the provider itself.
  provider: { fontFamily: "'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif" },
  page: { minHeight: "100vh", backgroundColor: colors.background, color: colors.text },
});

function LanguageBridge() {
  const { lang } = useI18n();
  useEffect(() => {
    setLanguageGetter(() => lang);
  }, [lang]);
  return null;
}

export interface AppProps {
  /** Force a mode (tests / screenshots); defaults to auto-detection. */
  mode?: "read" | "compose";
}

export function App({ mode }: AppProps) {
  const s = useStyles();
  const preview = useMemo(() => isPreviewMode(), []);
  const compose = mode ? mode === "compose" : isComposeMode();
  const [api, setApi] = useState<OaoApi | null>(null);

  useEffect(() => {
    let alive = true;
    initApi({ preview }).then((a) => alive && setApi(a));
    return () => {
      alive = false;
    };
  }, [preview]);

  const ctx = useMemo(() => ({ preview, api: api ?? getApi(), adminUrl: adminUrl(), complianceEmail: complianceEmail() }), [preview, api]);

  return (
    <FluentProvider theme={webLightTheme} className={s.provider}>
      <I18nProvider>
        <LanguageBridge />
        <ToastProvider>
          <AppContext.Provider value={ctx}>
            <div className={s.page}>
              {api === null ? null : compose ? <ComplianceGuardian /> : <ReadMode initialTab={queryParam("tab")} initialView={queryParam("view")} />}
            </div>
          </AppContext.Provider>
        </ToastProvider>
      </I18nProvider>
    </FluentProvider>
  );
}

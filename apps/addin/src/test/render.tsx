import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { AppContext } from "@/app/AppContext";
import { createMockClient } from "@/api/mock";
import type { OaoApi } from "@/api/types";
import { mockFeatures } from "@/api/mockBrief";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/ui/toast";
import type { FeatureFlags, Language } from "@oao/shared";

export function renderWithProviders(ui: ReactElement, opts: RenderOptions & { lang?: Language; features?: FeatureFlags | null; api?: OaoApi } = {}) {
  const api = opts.api ?? createMockClient(() => opts.lang ?? "en", 0);
  return render(
    <FluentProvider theme={webLightTheme}>
      <I18nProvider initial={opts.lang ?? "en"}>
        <ToastProvider>
          <AppContext.Provider value={{ preview: true, api, adminUrl: "http://admin.test", complianceEmail: "compliance@test", features: opts.features ?? mockFeatures(), openSettings: () => undefined }}>{ui}</AppContext.Provider>
        </ToastProvider>
      </I18nProvider>
    </FluentProvider>,
    opts,
  );
}

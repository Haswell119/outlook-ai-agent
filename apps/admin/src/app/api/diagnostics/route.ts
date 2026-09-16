import { NextResponse } from "next/server";
import { adminConfig, getFeatures, getHealth, isMockMode, organizationName } from "@/lib/api";
import { handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * `GET /api/diagnostics` → a JSON attachment with health, feature flags and
 * versions, for a support ticket.
 *
 * Secrets are never included: no bearer token, no client secret, no connection
 * string, no email content — only the orchestrator URL and the flags the
 * dashboard already displays.
 */
export async function GET() {
  try {
    await requireRoles("admin");
    const cfg = adminConfig();
    const [health, features, mock, organisation] = await Promise.all([
      getHealth(),
      getFeatures(),
      isMockMode(),
      organizationName(),
    ]);
    const payload = {
      generatedAt: new Date().toISOString(),
      dashboard: {
        app: "@oao/admin",
        orchestratorUrl: cfg.orchestratorUrl,
        authMode: cfg.authMode,
        dataMode: mock ? "mock" : "live",
        defaultLanguage: cfg.defaultLanguage,
        timeZone: cfg.timeZone,
        organisation,
      },
      orchestrator: { health, features },
    };
    const filename = `oao-diagnostics-${payload.generatedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error, "diagnostics_failed");
  }
}

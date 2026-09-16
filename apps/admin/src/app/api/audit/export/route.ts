import { NextResponse } from "next/server";
import { getAuditEventsForExport, streamAuditExport } from "@/lib/api";
import { auditEventsToCsv } from "@/lib/csv";
import { handleRouteError } from "@/lib/http";
import { resolveQuery } from "@/lib/query";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

const UTF8_BOM = "﻿";

export function exportFilename(from: string, to: string): string {
  return `audit-log-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`;
}

/**
 * `GET /api/audit/export?range=…&user=…&type=…` → `text/csv` attachment.
 *
 * Preferred path: the orchestrator's own `Routes.auditExport` is **streamed
 * through** this handler, so a 200k-row export never sits in the dashboard's
 * memory and the bearer token stays server-side. When that route is not
 * available (mock mode, or an older orchestrator) the CSV is rebuilt from the
 * paginated reads — the original client-side fallback.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const query = resolveQuery(params);
  const filename = exportFilename(query.from, query.to);

  try {
    await requireRoles("admin", "compliance");

    const upstream = await streamAuditExport(query);
    if (upstream) {
      return new NextResponse(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": upstream.contentType,
          "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const events = await getAuditEventsForExport(query);
    return new NextResponse(`${UTF8_BOM}${auditEventsToCsv(events)}`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error, "export_failed");
  }
}

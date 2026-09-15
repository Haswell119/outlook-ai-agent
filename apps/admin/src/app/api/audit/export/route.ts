import { NextResponse } from "next/server";
import { getAuditEventsForExport } from "@/lib/api";
import { auditEventsToCsv } from "@/lib/csv";
import { resolveQuery } from "@/lib/query";

export const dynamic = "force-dynamic";

/** GET /api/audit/export?range=…&user=…&type=… → text/csv attachment. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  const query = resolveQuery(params);

  try {
    const events = await getAuditEventsForExport(query);
    const csv = auditEventsToCsv(events);
    const stamp = `${query.from.slice(0, 10)}_${query.to.slice(0, 10)}`;
    return new NextResponse(`﻿${csv}`, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${stamp}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "export_failed",
          message: error instanceof Error ? error.message : "Export failed",
        },
      },
      { status: 502 },
    );
  }
}

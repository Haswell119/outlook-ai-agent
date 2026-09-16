import { NextResponse } from "next/server";
import { getSystemStatus, isMockMode } from "@/lib/api";
import { handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Polled every 15 s by `/system`. */
export async function GET() {
  try {
    await requireRoles("admin");
    const [status, mock] = await Promise.all([getSystemStatus(), isMockMode()]);
    return NextResponse.json(
      { status, mock, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleRouteError(error, "system_unavailable");
  }
}

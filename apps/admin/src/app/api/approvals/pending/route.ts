import { NextResponse } from "next/server";
import { getPendingEscalationCount } from "@/lib/api";
import { handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Polled every 30 s by the sidebar badge. */
export async function GET() {
  try {
    await requireRoles("admin", "compliance");
    return NextResponse.json(
      { pending: await getPendingEscalationCount() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return handleRouteError(error, "approvals_unavailable");
  }
}

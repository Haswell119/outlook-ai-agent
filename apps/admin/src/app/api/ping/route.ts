import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness probe (excluded from the middleware matcher). */
export function GET() {
  return NextResponse.json(
    { status: "ok", app: "@oao/admin", timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

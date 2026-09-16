import { NextResponse } from "next/server";
import { getFeatures, getHealth, isMockMode } from "@/lib/api";
import { handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Backing call of the "Re-check" button on `/settings`. */
export async function GET() {
  try {
    await requireRoles("admin");
    const [health, features, mock] = await Promise.all([getHealth(), getFeatures(), isMockMode()]);
    return NextResponse.json({ health, features, mock });
  } catch (error) {
    return handleRouteError(error, "health_unavailable");
  }
}

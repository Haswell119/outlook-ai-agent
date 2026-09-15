import { NextResponse } from "next/server";
import { getFeatures, getHealth, isMockMode } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Backing call of the "Re-check" button on /settings. */
export async function GET() {
  try {
    const [health, features, mock] = await Promise.all([getHealth(), getFeatures(), isMockMode()]);
    return NextResponse.json({ health, features, mock });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "health_unavailable", message: error instanceof Error ? error.message : "Failed" } },
      { status: 502 },
    );
  }
}

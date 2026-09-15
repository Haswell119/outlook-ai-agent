import { NextResponse } from "next/server";
import { PolicySchema } from "@oao/shared";
import { OrchestratorError, getPolicy, savePolicy } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getPolicy());
  } catch (error) {
    return NextResponse.json(
      { error: { code: "policy_unavailable", message: error instanceof Error ? error.message : "Failed" } },
      { status: 502 },
    );
  }
}

/** PUT /api/policy → validates with the shared contract, then PUT Routes.adminPolicy. */
export async function PUT(request: Request) {
  const parsed = PolicySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: "Invalid policy payload",
          details: parsed.error.issues.slice(0, 10),
        },
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await savePolicy(parsed.data));
  } catch (error) {
    const status = error instanceof OrchestratorError ? error.status : 502;
    return NextResponse.json(
      { error: { code: "save_failed", message: error instanceof Error ? error.message : "Save failed" } },
      { status },
    );
  }
}

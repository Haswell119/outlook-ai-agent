import { NextResponse } from "next/server";
import { z } from "zod";
import { OrchestratorError, decideAutomation } from "@/lib/api";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  action: z.enum(["approve", "reject", "pause"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "action must be 'approve', 'reject' or 'pause'" } },
      { status: 400 },
    );
  }
  try {
    const automation = await decideAutomation(id, parsed.data.action, parsed.data.comment);
    return NextResponse.json(automation);
  } catch (error) {
    const status = error instanceof OrchestratorError ? error.status : 502;
    return NextResponse.json(
      {
        error: {
          code: error instanceof OrchestratorError ? (error.code ?? "decision_failed") : "decision_failed",
          message: error instanceof Error ? error.message : "Decision failed",
        },
      },
      { status },
    );
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { OrchestratorError, decideEscalation } from "@/lib/api";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "decision must be 'approve' or 'reject'" } },
      { status: 400 },
    );
  }
  try {
    const escalation = await decideEscalation(id, parsed.data.decision, parsed.data.comment);
    return NextResponse.json(escalation);
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

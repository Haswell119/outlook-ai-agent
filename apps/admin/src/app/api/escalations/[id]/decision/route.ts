import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decideEscalation } from "@/lib/api";
import { errorResponse, handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

const BodySchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    comment: z.string().max(2000).optional(),
  })
  // `docs/SECURITY.md` §6: a rejection must carry a justification for the audit trail.
  .refine((b) => b.decision !== "reject" || (b.comment?.trim().length ?? 0) > 0, {
    message: "A comment is required to reject an escalation",
    path: ["comment"],
  });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireRoles("admin", "compliance");
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse(
        "validation_error",
        parsed.error.issues[0]?.message ?? "Invalid decision payload",
        400,
        undefined,
        parsed.error.issues.slice(0, 5),
      );
    }
    const escalation = await decideEscalation(
      id,
      parsed.data.decision,
      parsed.data.comment?.trim(),
      session.name || session.email,
    );
    revalidatePath("/approvals");
    revalidatePath("/alerts");
    revalidatePath("/");
    return NextResponse.json(escalation);
  } catch (error) {
    return handleRouteError(error, "decision_failed");
  }
}

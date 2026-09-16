import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decideAutomation } from "@/lib/api";
import { errorResponse, handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  action: z.enum(["approve", "reject", "pause", "resume"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireRoles("admin");
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse(
        "validation_error",
        "action must be 'approve', 'reject', 'pause' or 'resume'",
        400,
      );
    }
    const automation = await decideAutomation(id, parsed.data.action, parsed.data.comment?.trim());
    revalidatePath("/automations");
    return NextResponse.json(automation);
  } catch (error) {
    return handleRouteError(error, "decision_failed");
  }
}

import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { PolicySchema } from "@oao/shared";
import { getPolicy, savePolicy } from "@/lib/api";
import { errorResponse, handleRouteError } from "@/lib/http";
import { validateRegex } from "@/lib/policy-preview";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRoles("admin");
    return NextResponse.json(await getPolicy());
  } catch (error) {
    return handleRouteError(error, "policy_unavailable");
  }
}

/** `PUT /api/policy` → validated with the shared contract, then `PUT Routes.adminPolicy`. */
export async function PUT(request: Request) {
  try {
    const session = await requireRoles("admin");
    const parsed = PolicySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("validation_error", "Invalid policy payload", 400, undefined, {
        issues: parsed.error.issues.slice(0, 10),
      });
    }
    const broken = parsed.data.sensitiveDataPatterns
      .map((p) => ({ name: p.name, check: validateRegex(p.pattern) }))
      .filter((p) => !p.check.valid);
    if (broken.length > 0) {
      return errorResponse(
        "validation_error",
        `Invalid regular expression: ${broken.map((b) => b.name || "(unnamed)").join(", ")}`,
        400,
        undefined,
        broken,
      );
    }
    const saved = await savePolicy(parsed.data, session.email);
    revalidatePath("/policy");
    return NextResponse.json(saved);
  } catch (error) {
    return handleRouteError(error, "save_failed");
  }
}

import { NextResponse } from "next/server";
import { MailboxImportRequestSchema } from "@oao/shared";
import { importMailFiles } from "@/lib/api";
import { errorResponse, handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * `POST /api/import` — one batch of `.eml` / `.msg` files from `/integrations`,
 * validated with the shared contract, then `POST Routes.mailboxImport`.
 *
 * JSON only: a cross-site HTML form can post `text/plain` without a CORS
 * preflight, never `application/json`.
 */
export async function POST(request: Request) {
  try {
    await requireRoles("admin");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return errorResponse("validation_error", "Expected an application/json body", 415);
    }
    const parsed = MailboxImportRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      // Paths and messages only: an issue never echoes a file's content.
      return errorResponse("validation_error", "Invalid import payload", 400, undefined, {
        issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return NextResponse.json(await importMailFiles(parsed.data));
  } catch (error) {
    return handleRouteError(error, "import_failed");
  }
}

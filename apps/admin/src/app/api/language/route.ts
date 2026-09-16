import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, handleRouteError } from "@/lib/http";
import { LANGUAGE_COOKIE } from "@/lib/i18n";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ language: z.enum(["en", "fr"]) });

export async function POST(request: Request) {
  try {
    await requireRoles();
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return errorResponse("validation_error", "language must be 'en' or 'fr'", 400);
    }
    const res = NextResponse.json({ language: parsed.data.language });
    res.cookies.set(LANGUAGE_COOKIE, parsed.data.language, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  } catch (error) {
    return handleRouteError(error, "language_failed");
  }
}

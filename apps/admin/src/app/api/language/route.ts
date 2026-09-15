import { NextResponse } from "next/server";
import { z } from "zod";
import { LANGUAGE_COOKIE } from "@/lib/i18n";

const BodySchema = z.object({ language: z.enum(["en", "fr"]) });

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "language must be 'en' or 'fr'" } },
      { status: 400 },
    );
  }
  const res = NextResponse.json({ language: parsed.data.language });
  res.cookies.set(LANGUAGE_COOKIE, parsed.data.language, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return res;
}

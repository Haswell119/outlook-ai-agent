import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { triggerMailboxSync } from "@/lib/api";
import { handleRouteError } from "@/lib/http";
import { requireRoles } from "@/lib/session";

export const dynamic = "force-dynamic";

/** "Sync now" on `/system` → `POST Routes.mailboxSync`. */
export async function POST() {
  try {
    await requireRoles("admin");
    const sync = await triggerMailboxSync();
    revalidatePath("/system");
    return NextResponse.json({ sync });
  } catch (error) {
    return handleRouteError(error, "sync_failed");
  }
}

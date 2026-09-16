/**
 * Office.js environment helpers. Everything here is defensive: the task pane
 * can be opened directly in a browser ("preview mode") to review the UI.
 */
import { hashString } from "@/util/hash";

type OfficeGlobal = typeof Office | undefined;

export function officeGlobal(): OfficeGlobal {
  return (globalThis as { Office?: typeof Office }).Office;
}

/** True when Office.js is loaded AND we run inside Outlook with a mailbox. */
export function isOfficeAvailable(): boolean {
  try {
    const office = officeGlobal();
    return !!office?.context?.mailbox;
  } catch {
    return false;
  }
}

/**
 * True when Office.js is loaded *and* reports an Office/Outlook context, even
 * when that context carries no mailbox (the personal-tab surface in the new
 * Outlook / Outlook on the web). In a plain browser `Office.context` is
 * undefined, which is what separates "hosted, no mailbox" from "dev preview".
 */
export function isOfficeHost(): boolean {
  try {
    const ctx = officeGlobal()?.context as unknown as { host?: unknown; platform?: unknown; mailbox?: unknown } | undefined;
    // Truthy, not merely defined: office.js loaded in a plain browser leaves
    // `host` / `platform` null, and that must stay browser preview.
    return !!ctx && (!!ctx.host || !!ctx.platform || !!ctx.mailbox);
  } catch {
    return false;
  }
}

/** Where the pane is running. */
export type AppHost = "outlook" | "tab" | "browser";

/**
 * `?host=tab` — the personal tab declared by `staticTabs` in the unified
 * manifest, shown in the "Apps" rail of the new Outlook / Outlook on the web.
 * There is no `Office.context.mailbox` there, so every Office.js call must be
 * guarded; the pane runs mailbox-wide ("home" mode) against the real backend.
 */
export function isTabHost(): boolean {
  if (queryParam("host") === "tab") return true;
  // Hosted by Office but without a mailbox → same story as the personal tab.
  return isOfficeHost() && !isOfficeAvailable();
}

export function hostSurface(): AppHost {
  if (isOfficeAvailable()) return "outlook";
  if (isTabHost()) return "tab";
  return "browser";
}

/**
 * Browser preview: sample email + toasts instead of Office.js calls.
 *
 * Preview mode is for **browser development only**. It is *not* the same thing
 * as "no mailbox": the Apps-rail entry (`?host=tab`) and the explicit home view
 * (`?view=home`) also have no mailbox, but they talk to the real backend and
 * must never show the sample email. `?preview=1` forces preview anywhere.
 */
export function isPreviewMode(): boolean {
  if (queryParam("preview") === "1") return true;
  if (isOfficeAvailable()) return false;
  if (isTabHost() || queryParam("view") === "home") return false;
  return true;
}

/** Guarded requirement-set check (never throws). */
export function isSetSupported(name: string, version: string): boolean {
  try {
    return !!officeGlobal()?.context?.requirements?.isSetSupported(name, version);
  } catch {
    return false;
  }
}

export function queryParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** Compose mode: `?mode=compose` or the current item is a compose item (subject is an accessor object). */
export function isComposeMode(): boolean {
  if (queryParam("mode") === "compose") return true;
  if (!isOfficeAvailable()) return false;
  try {
    const item = officeGlobal()?.context.mailbox.item as unknown as { subject?: unknown } | undefined;
    return !!item && typeof item.subject === "object" && item.subject !== null && "getAsync" in (item.subject as object);
  } catch {
    return false;
  }
}

/**
 * Resolve once Office.js is ready. If office.js never loads (offline browser
 * preview) we resolve after `timeoutMs` so the UI still renders.
 */
export function waitForOffice(timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const office = officeGlobal();
    if (!office || typeof office.onReady !== "function") {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      office.onReady(() => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/** Promisify the Office.js callback style (`AsyncResult`). */
export function asyncResult<T>(fn: (cb: (r: Office.AsyncResult<T>) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      fn((r) => {
        if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value);
        else reject(new Error(r.error?.message ?? "Office.js call failed"));
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Same as asyncResult but returns `fallback` instead of throwing (best-effort reads). */
export async function tryAsync<T>(fn: (cb: (r: Office.AsyncResult<T>) => void) => void, fallback: T): Promise<T> {
  try {
    return await asyncResult(fn);
  } catch {
    return fallback;
  }
}

/** Current user (Office user profile) or preview defaults. */
export function currentUser(): { email: string; name: string } {
  try {
    const profile = officeGlobal()?.context?.mailbox?.userProfile;
    if (profile?.emailAddress) return { email: profile.emailAddress, name: profile.displayName ?? profile.emailAddress };
  } catch {
    /* ignore */
  }
  return { email: "jane.smith@northbridge.example", name: "Jane Smith" };
}

/**
 * Stable, non-reversible identifier of the **mailbox** the pane is open on.
 *
 * Every local store is per-origin, not per-mailbox, and Outlook on the web lets
 * one browser profile switch accounts. Without this in the key, the daily brief
 * (cached as `brief:<date>:<lang>`) and the per-session conversation cache were
 * served to whoever opened the pane next on that machine. The address is
 * hashed, so nothing readable about the user is written to disk.
 */
export function mailboxScope(): string {
  try {
    return hashString(currentUser().email.trim().toLowerCase());
  } catch {
    return "anonymous";
  }
}

/**
 * Convert an Office.js `itemId` to the **stable REST id** the precompute worker
 * uses as its key.
 *
 * `Office.context.mailbox.convertToRestId(itemId, RestVersion.v2_0)` turns the
 * EWS id served by Outlook desktop into the Graph/Outlook-REST id, so
 * `GET /analyze/email/:id` matches what the mailbox sync worker stored.
 *
 * Fallbacks, in order:
 *  1. requirement set Mailbox 1.3 present and the call succeeds → REST id
 *  2. the id already looks like a REST id (base64url, no EWS padding) → as-is
 *  3. anything else → the raw `itemId` (the backend answers 404 and we analyse)
 *
 * Outlook on the web and the new Outlook already hand out REST ids, in which
 * case `convertToRestId` is a no-op — calling it is still correct and cheap.
 */
export function toStableEmailId(itemId: string | undefined | null): string {
  const id = (itemId ?? "").trim();
  if (!id) return "";
  try {
    const mailbox = officeGlobal()?.context?.mailbox;
    const restVersion = (officeGlobal() as unknown as { MailboxEnums?: { RestVersion?: { v2_0?: unknown } } })?.MailboxEnums?.RestVersion?.v2_0;
    if (mailbox?.convertToRestId && isSetSupported("Mailbox", "1.3") && restVersion !== undefined) {
      const converted = mailbox.convertToRestId(id, restVersion as Office.MailboxEnums.RestVersion);
      if (typeof converted === "string" && converted.length > 0) return converted;
    }
  } catch {
    /* host refused the conversion (e.g. a draft with no id yet) */
  }
  return id;
}

/** True when `id` is shaped like an Outlook REST / Graph message id. */
export function looksLikeRestId(id: string): boolean {
  return /^[A-Za-z0-9_-]{60,}={0,2}$/.test(id);
}

/**
 * True when Outlook currently has a message selected.
 *
 * `Office.context.mailbox.item` is null when the pane is opened from the
 * "New mail"/ribbon surface with nothing selected, or from the Apps menu on an
 * empty reading pane — that is when the daily brief is shown instead.
 */
export function hasSelectedItem(): boolean {
  try {
    return !!officeGlobal()?.context?.mailbox?.item;
  } catch {
    return false;
  }
}

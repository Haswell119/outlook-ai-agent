/**
 * Office.js environment helpers. Everything here is defensive: the task pane
 * can be opened directly in a browser ("preview mode") to review the UI.
 */

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

/** Browser preview: no Office host (or no mailbox) → sample data + toasts. */
export function isPreviewMode(): boolean {
  return !isOfficeAvailable();
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
  return { email: "jane.smith@longbow.ch", name: "Jane Smith" };
}

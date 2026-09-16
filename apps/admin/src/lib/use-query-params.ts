"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * All dashboard filters live in the URL so that a filtered view is shareable and
 * the server components can render them without client state.
 */
export function useQueryParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const get = useCallback((key: string, fallback = "") => searchParams.get(key) ?? fallback, [searchParams]);

  const setMany = useCallback(
    (updates: Record<string, string | number | undefined | null>, opts?: { resetPage?: boolean }) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === null || value === "" || value === "all") next.delete(key);
        else next.set(key, String(value));
      }
      if (opts?.resetPage !== false) next.delete("page");
      const qs = next.toString();
      startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [pathname, router, searchParams],
  );

  const set = useCallback(
    (key: string, value: string | number | undefined | null, opts?: { resetPage?: boolean }) =>
      setMany({ [key]: value }, opts),
    [setMany],
  );

  const reset = useCallback(
    (keys: string[]) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const k of keys) next.delete(k);
      next.delete("page");
      const qs = next.toString();
      startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [pathname, router, searchParams],
  );

  return { get, set, setMany, reset, pending, searchParams, pathname };
}

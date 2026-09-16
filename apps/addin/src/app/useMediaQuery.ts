import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const get = () => {
    try {
      return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false;
    } catch {
      return false;
    }
  };
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    try {
      const mql = window.matchMedia(query);
      const handler = () => setMatches(mql.matches);
      handler();
      mql.addEventListener?.("change", handler);
      return () => mql.removeEventListener?.("change", handler);
    } catch {
      return undefined;
    }
  }, [query]);
  return matches;
}

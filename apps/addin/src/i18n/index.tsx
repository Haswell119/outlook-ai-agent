import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Language } from "@oao/shared";
import en from "./en.json";
import fr from "./fr.json";

type Dict = { [key: string]: string | Dict };
export const resources: Record<Language, Dict> = { en, fr };

const STORAGE_KEY = "oao.addin.language";

/** Flatten a nested dictionary into dot-separated keys (used by tests and lookups). */
export function flattenKeys(dict: Dict, prefix = ""): string[] {
  return Object.entries(dict).flatMap(([k, v]) =>
    typeof v === "string" ? [prefix + k] : flattenKeys(v, `${prefix}${k}.`),
  );
}

function lookup(dict: Dict, key: string): string | undefined {
  let cur: string | Dict | undefined = dict;
  for (const part of key.split(".")) {
    if (cur === undefined || typeof cur === "string") return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

export type TParams = Record<string, string | number>;

export function translate(lang: Language, key: string, params?: TParams): string {
  const raw = lookup(resources[lang], key) ?? lookup(resources.en, key) ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => (params[name] !== undefined ? String(params[name]) : `{${name}}`));
}

/** Detect the language from Office (displayLanguage) or the browser, with a persisted manual override. */
export function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "fr" || stored === "en") return stored;
  } catch {
    /* ignore */
  }
  let tag = "";
  try {
    const office = (globalThis as { Office?: { context?: { displayLanguage?: string } } }).Office;
    tag = office?.context?.displayLanguage ?? "";
  } catch {
    /* ignore */
  }
  if (!tag && typeof navigator !== "undefined") tag = navigator.language ?? "";
  return tag.toLowerCase().startsWith("fr") ? "fr" : "en";
}

interface I18nContextValue {
  lang: Language;
  setLang: (l: Language) => void;
  t: (key: string, params?: TParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Language }) {
  const [lang, setLangState] = useState<Language>(initial ?? detectLanguage());
  const setLang = useCallback((l: Language) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang, setLang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Allows components to be rendered without the provider (tests, commands runtime).
    const lang = detectLanguage();
    return { lang, setLang: () => undefined, t: (key, params) => translate(lang, key, params) };
  }
  return ctx;
}

/** Format an ISO date for display in the current language. */
export function formatDate(iso: string | undefined, lang: Language, withTime = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === "fr" ? "fr-CH" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

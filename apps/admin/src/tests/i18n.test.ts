import { describe, expect, it } from "vitest";
import { createTranslator, dictionaries, interpolate, messageKeys, tr } from "@/lib/i18n";

describe("i18n dictionaries", () => {
  it("keeps FR and EN at strict key parity", () => {
    const en = Object.keys(dictionaries.en).sort();
    const fr = Object.keys(dictionaries.fr).sort();
    expect(fr).toEqual(en);
    expect(en.length).toBeGreaterThan(300);
  });

  it("never leaves a translation empty or untranslated by mistake", () => {
    const untranslated: string[] = [];
    for (const key of messageKeys()) {
      const en = dictionaries.en[key];
      const fr = dictionaries.fr[key];
      expect(fr.trim().length, `empty FR value for ${key}`).toBeGreaterThan(0);
      expect(en.trim().length, `empty EN value for ${key}`).toBeGreaterThan(0);
      if (en === fr && /[a-z]{4,}\s+[a-z]{4,}/i.test(en)) untranslated.push(key);
    }
    // Product names are identical on purpose; anything else would be an oversight.
    expect(untranslated).toEqual(["settings.graph"]);
  });

  it("keeps the placeholders of a message identical in both languages", () => {
    const placeholders = (value: string) => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    for (const key of messageKeys()) {
      expect(placeholders(dictionaries.fr[key]), `placeholders differ for ${key}`).toEqual(
        placeholders(dictionaries.en[key]),
      );
    }
  });

  it("interpolates every occurrence of a placeholder", () => {
    expect(interpolate("{count} pending", { count: 3 })).toBe("3 pending");
    expect(interpolate("{a}-{b}-{a}", { a: "x", b: "y" })).toBe("x-y-x");
    expect(interpolate("nothing")).toBe("nothing");
  });

  it("falls back to English then to the key itself", () => {
    expect(tr(dictionaries.fr as Record<string, string>, "nav.overview")).toBe("Vue d'ensemble");
    expect(tr({}, "nav.overview")).toBe("Overview");
    expect(tr({}, "totally.unknown.key")).toBe("totally.unknown.key");
    expect(createTranslator("fr")("approvals.pendingBadge", { count: 2 })).toBe("2 en attente");
  });
});

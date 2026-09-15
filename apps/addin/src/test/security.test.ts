/**
 * Guardrails that are cheaper to assert than to review.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenKeys, resources, translate } from "@/i18n";
import { SSO_ERRORS } from "@/office/sso";

const SRC = join(__dirname, "..");

function sourceFiles(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "test") continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments may legitimately *mention* the APIs we forbid in code. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("no unsanitised HTML injection anywhere in the pane", () => {
  it("does not use dangerouslySetInnerHTML or innerHTML on model output", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = stripComments(readFileSync(file, "utf8"));
      if (code.includes("dangerouslySetInnerHTML")) offenders.push(`${file}: dangerouslySetInnerHTML`);
      // `.innerHTML =` would bypass React's escaping just as badly.
      if (/\.innerHTML\s*=/.test(code)) offenders.push(`${file}: innerHTML assignment`);
      if (/document\.write\s*\(/.test(code)) offenders.push(`${file}: document.write`);
    }
    expect(offenders).toEqual([]);
  });

  it("only builds HTML through the escaping helper", () => {
    // office/actions.ts is the single place that produces HTML (reply bodies).
    const producers = sourceFiles().filter((f) => /htmlBody/.test(readFileSync(f, "utf8")));
    expect(producers.length).toBeGreaterThan(0);
    const actions = readFileSync(join(SRC, "office", "actions.ts"), "utf8");
    expect(actions).toContain("escapeHtml");
  });
});

describe("i18n completeness", () => {
  it("has exactly the same keys in FR and EN, including the new screens", () => {
    const en = flattenKeys(resources.en).sort();
    const fr = flattenKeys(resources.fr).sort();
    expect(fr).toEqual(en);
    expect(en.length).toBeGreaterThan(250);
  });

  it("covers every new surface in both languages", () => {
    const required = [
      "brief.title",
      "brief.regenerateBody",
      "brief.stat.newEmails",
      "sync.title",
      "sync.state.idle",
      "settings.title",
      "settings.clearCache",
      "settings.telemetryHint",
      "source.precomputed",
      "source.tip.precomputed",
      "triage.analyseAnyway",
      "triage.kind.newsletter",
      "errors.boundaryTitle",
      "errors.report",
      "compliance.bannerTitle",
      "compliance.showPanel",
      "app.offline",
    ];
    for (const key of required) {
      for (const lang of ["en", "fr"] as const) {
        const value = translate(lang, key);
        expect(value, `${lang}/${key}`).not.toBe(key);
        expect(value.length, `${lang}/${key}`).toBeGreaterThan(1);
      }
    }
  });

  it("has a message for every documented SSO error code in both languages", () => {
    for (const code of Object.keys(SSO_ERRORS)) {
      for (const lang of ["en", "fr"] as const) {
        const key = `errors.sso.${code}`;
        expect(translate(lang, key), `${lang}/${key}`).not.toBe(key);
      }
    }
    expect(translate("en", "errors.sso.generic")).not.toBe("errors.sso.generic");
  });
});

describe("public-repository rule", () => {
  it("uses only placeholder organisation names in the source", () => {
    // Sample fixtures may reference the placeholder org; nothing else may.
    const banned = /northbridge\.(ch|com|local)\b/i;
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const code = readFileSync(file, "utf8");
      if (banned.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("never hard-codes an organisation name in a UI string", () => {
    for (const lang of ["en", "fr"] as const) {
      const json = JSON.stringify(resources[lang]);
      expect(json).not.toMatch(/Northbridge/i);
      expect(json).not.toMatch(/ABC Capital/i);
    }
  });
});

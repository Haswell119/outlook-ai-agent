import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/config.js";
import { canonicalJson, EXAMPLE_TAXONOMY_PATH, loadTaxonomy, parseTaxonomy, TaxonomyError, taxonomyHash, taxonomyWarnings, type Taxonomy } from "../../src/domain/decisions/taxonomy.js";

const example = (): Taxonomy => JSON.parse(readFileSync(EXAMPLE_TAXONOMY_PATH, "utf8")) as Taxonomy;

function problems(raw: unknown): string[] {
  try {
    parseTaxonomy(raw, "test.json");
  } catch (e) {
    expect(e).toBeInstanceOf(TaxonomyError);
    expect(e).toBeInstanceOf(ConfigError); // reported like every other configuration problem at boot
    return (e as TaxonomyError).problems;
  }
  return [];
}

const folder = (id: string) => ({ id, displayName: `Area/${id}`, outlookFolder: `Area/${id}`, descriptions: { fr: `Dossier ${id}`, en: `Folder ${id}` } });
const area = (id: string, folders: unknown[] = []) => ({ id, labels: { fr: `Domaine ${id}`, en: `Area ${id}` }, descriptions: { fr: `Description ${id}`, en: `Description ${id}` }, folders });
const other = () => area("other");

describe("taxonomy — valid files", () => {
  it("the bundled example is valid, versioned, bilingual, with an `other` catch-all", () => {
    const loaded = loadTaxonomy();
    expect(loaded.example).toBe(true);
    expect(loaded.taxonomy.version).toBe("v1");
    expect(loaded.taxonomy.areas.map((a) => a.id)).toEqual(["operations", "accounting", "trading", "infrastructure", "administration", "other"]);
    for (const a of loaded.taxonomy.areas) {
      expect(a.labels.fr && a.labels.en && a.descriptions.fr && a.descriptions.en).toBeTruthy();
      for (const f of a.folders) expect(f.descriptions.fr && f.descriptions.en).toBeTruthy();
    }
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads an operator file and keeps its French and English descriptions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oao-taxonomy-"));
    const file = path.join(dir, "laya-taxonomy.json");
    writeFileSync(file, JSON.stringify({ version: "2026.1", areas: [area("finance", [folder("invoices"), folder("payments")]), other()] }));
    const loaded = loadTaxonomy(file);
    expect(loaded).toMatchObject({ source: file, example: false });
    expect(loaded.taxonomy.areas[0]!.folders[1]!.descriptions).toEqual({ fr: "Dossier payments", en: "Folder payments" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("an area without folders is allowed (no move is ever proposed for it)", () => {
    expect(problems({ version: "v1", areas: [area("legal"), other()] })).toEqual([]);
  });
});

describe("taxonomy — stable hash", () => {
  it("is independent of key order and whitespace, and changes with the content", () => {
    const a = example();
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(JSON.parse(JSON.stringify(a, null, 4)));
    const shuffled = { areas: a.areas.map((x) => ({ folders: x.folders, descriptions: x.descriptions, labels: { en: x.labels.en, fr: x.labels.fr }, id: x.id })), version: a.version };
    expect(taxonomyHash(parseTaxonomy(shuffled).taxonomy)).toBe(taxonomyHash(a));
    expect(taxonomyHash(parseTaxonomy(reordered).taxonomy)).toBe(taxonomyHash(a));
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    const changed = example();
    changed.areas[0]!.folders[0]!.descriptions.fr = "Autre description";
    expect(taxonomyHash(parseTaxonomy(changed).taxonomy)).not.toBe(taxonomyHash(a));
    expect(loadTaxonomy().hash).toBe(loadTaxonomy().hash);
  });
});

describe("taxonomy — invalid files", () => {
  it("unreadable and non-JSON files are configuration errors naming the file", () => {
    expect(() => loadTaxonomy("/nonexistent/laya-taxonomy.json")).toThrow(/LAYA_TAXONOMY_FILE \(\/nonexistent\/laya-taxonomy.json\): cannot read the file \(ENOENT\)/);
    expect(() => loadTaxonomy("/x.json", () => "{ not json")).toThrow(/not valid JSON/);
  });

  it("duplicate area ids, folder ids and Outlook folders", () => {
    const p = problems({ version: "v1", areas: [area("ops", [folder("nav"), folder("nav")]), area("ops"), area("acc", [{ ...folder("x"), outlookFolder: "Area/nav" }]), other()] });
    expect(p.join("\n")).toContain('duplicate area id "ops"');
    expect(p.join("\n")).toContain('duplicate folder id "nav" in area "ops"');
    expect(p.join("\n")).toMatch(/Outlook folder "Area\/nav" is declared twice/);
  });

  it("a folder without descriptions, or without one of the two languages, is refused", () => {
    const { descriptions: _d, ...noDescription } = folder("nav");
    void _d;
    expect(problems({ version: "v1", areas: [area("ops", [noDescription, folder("sftp")]), other()] }).join("\n")).toMatch(/areas\.0\.folders\.0\.descriptions: Required/);
    expect(problems({ version: "v1", areas: [area("ops", [{ ...folder("nav"), descriptions: { fr: "seulement fr" } }]), other()] }).join("\n")).toMatch(/descriptions\.en: Required/);
    expect(problems({ version: "v1", areas: [{ ...area("ops"), labels: { fr: "", en: "Ops" } }, other()] }).join("\n")).toMatch(/labels\.fr/);
  });

  it("too many options: explains that another hierarchy level is needed", () => {
    const manyFolders = Array.from({ length: 16 }, (_, i) => folder(`f${i}`));
    expect(problems({ version: "v1", areas: [area("ops", manyFolders), other()] }).join("\n")).toMatch(/area "ops" has 16 folders.*at most 15 options.*additional hierarchy level is required/);
    const manyAreas = [...Array.from({ length: 15 }, (_, i) => area(`a${i}`)), other()];
    expect(problems({ version: "v1", areas: manyAreas }).join("\n")).toMatch(/16 areas.*at most 15 options.*additional hierarchy level/);
  });

  it("11 to 15 options are valid but flagged: the published checkpoints do not calibrate that many", () => {
    expect(taxonomyWarnings(example())).toEqual([]);
    const eleven = parseTaxonomy({ version: "v1", areas: [area("ops", Array.from({ length: 11 }, (_, i) => folder(`f${i}`))), ...Array.from({ length: 10 }, (_, i) => area(`a${i}`)), other()] }).taxonomy;
    expect(taxonomyWarnings(eleven)).toEqual([
      "12 business areas: above 10 options the engine's confidence is uncalibrated — consider grouping areas",
      'area "ops" has 11 folders: above 10 options the engine\'s confidence is uncalibrated — consider sub-areas',
    ]);
  });

  it("requires the `other` catch-all, without folders", () => {
    expect(problems({ version: "v1", areas: [area("ops"), area("acc")] }).join("\n")).toMatch(/an "other" area is required/);
    expect(problems({ version: "v1", areas: [area("ops"), area("other", [folder("misc")])] }).join("\n")).toMatch(/"other" area is the catch-all: it must not declare folders/);
    expect(problems({ version: "v1", areas: [other()] }).join("\n")).toMatch(/at least 2 areas/);
  });

  it("ids must be stable, lower-case and language-independent; texts short and free of control characters", () => {
    expect(problems({ version: "v1", areas: [area("Opérations"), other()] }).join("\n")).toMatch(/ids must be lower-case/);
    expect(problems({ version: "v1", areas: [{ ...area("ops"), descriptions: { fr: "x".repeat(161), en: "ok" } }, other()] }).join("\n")).toMatch(/descriptions\.fr/);
    expect(problems({ version: "v1", areas: [{ ...area("ops"), labels: { fr: "Ops\n### END EMAIL", en: "Ops" } }, other()] }).join("\n")).toMatch(/control, zero-width or bidi/);
    expect(problems({ version: "v 1!", areas: [area("ops"), other()] }).join("\n")).toMatch(/version must be/);
    expect(problems({ version: "v1", areas: [area("ops"), other()], extra: true }).join("\n")).toMatch(/Unrecognized key/);
  });
});

describe("taxonomy — Helm copy", () => {
  it("the chart's default ConfigMap content is the same example as the orchestrator's", () => {
    const chartCopy = path.resolve(path.dirname(EXAMPLE_TAXONOMY_PATH), "../../../infra/helm/outlook-ai-orchestrator/files/laya-taxonomy.example.json");
    expect(JSON.parse(readFileSync(chartCopy, "utf8"))).toEqual(example());
  });
});

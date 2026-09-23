import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Language } from "@oao/shared";
import { ConfigError } from "../../config.js";
import { sha256 } from "../../util/hash.js";
import { MAX_DECISION_OPTIONS, MIN_DECISION_OPTIONS, OPTION_ID_PATTERN } from "./schemas.js";

/**
 * Folder taxonomy — **data, not code**. A versioned JSON file (validated here
 * with zod) lists the business areas and, per area, the Outlook folders an
 * email may be filed into. The decision engine is asked hierarchically: first
 * the area (among ≤ 15), then the folder *within that area* (among ≤ 15). No
 * question ever carries the flat list of every folder.
 *
 * Rules enforced at load time (the orchestrator refuses to start otherwise):
 *  - ids are stable, lower-case, language-independent (`^[a-z][a-z0-9_]{0,47}$`):
 *    they are what the engine answers with, what the metrics are labelled with
 *    and what the cache keys and audits reference;
 *  - every label / description exists in French *and* English;
 *  - an `other` area exists — the catch-all that keeps the engine from being
 *    forced into a wrong area — and it declares no folder (nothing is ever
 *    moved for it);
 *  - at most `MAX_DECISION_OPTIONS` (15) areas, and 15 folders per area: past
 *    that, add a hierarchy level instead (see docs/LAYA.md §taxonomy);
 *  - short texts (the engine renders every option into a small token budget).
 *
 * Operator file: `LAYA_TAXONOMY_FILE` (Helm: ConfigMap mounted at
 * /etc/oao/laya-taxonomy.json). Without it, the example bundled in
 * `apps/orchestrator/config/laya-taxonomy.example.json` is used — refused by
 * the configuration for `laya` + `active` in production.
 */

/** Longest label (area names are shown to the user). */
export const MAX_LABEL_CHARS = 60;
/**
 * Longest option description. Laya truncates each option to 48 tokens and
 * shares a 192–256-token budget between the instructions and all options:
 * long descriptions are cut silently, so they are refused here instead.
 */
export const MAX_DESCRIPTION_CHARS = 160;

/** Id of the mandatory catch-all area. */
export const OTHER_AREA_ID = "other";

/** Example taxonomy shipped with the orchestrator (dev / demo / shadow trials). */
export const EXAMPLE_TAXONOMY_PATH = fileURLToPath(new URL("../../../config/laya-taxonomy.example.json", import.meta.url));

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), "must not contain control, zero-width or bidi characters");

const localized = (max: number) => z.object({ fr: text(max), en: text(max) }).strict();

const optionId = z.string().regex(OPTION_ID_PATTERN, "ids must be lower-case, start with a letter and match ^[a-z][a-z0-9_]{0,47}$");

export const TaxonomyFolderSchema = z
  .object({
    id: optionId,
    /** Shown to the user ("Operations/NAV"). */
    displayName: text(120),
    /** Path handed to the move action (Outlook folder, `/`-separated). */
    outlookFolder: text(255),
    descriptions: localized(MAX_DESCRIPTION_CHARS),
  })
  .strict();

export const TaxonomyAreaSchema = z
  .object({
    id: optionId,
    labels: localized(MAX_LABEL_CHARS),
    descriptions: localized(MAX_DESCRIPTION_CHARS),
    folders: z.array(TaxonomyFolderSchema),
  })
  .strict();

export const TaxonomySchema = z
  .object({
    version: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/, "version must be 1-32 characters among letters, digits, '.', '_' and '-'"),
    areas: z.array(TaxonomyAreaSchema),
  })
  .strict()
  .superRefine((t, ctx) => {
    const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    if (t.areas.length < MIN_DECISION_OPTIONS) issue(`at least ${MIN_DECISION_OPTIONS} areas are required (one of them "${OTHER_AREA_ID}")`, ["areas"]);
    if (t.areas.length > MAX_DECISION_OPTIONS) {
      issue(`${t.areas.length} areas, but a question accepts at most ${MAX_DECISION_OPTIONS} options: group the areas under an additional hierarchy level (see docs/LAYA.md §taxonomy)`, ["areas"]);
    }
    const areaIds = new Set<string>();
    const outlookFolders = new Map<string, string>();
    t.areas.forEach((area, i) => {
      if (areaIds.has(area.id)) issue(`duplicate area id "${area.id}"`, ["areas", i, "id"]);
      areaIds.add(area.id);
      if (area.id === OTHER_AREA_ID && area.folders.length) issue(`the "${OTHER_AREA_ID}" area is the catch-all: it must not declare folders (no move is ever proposed for it)`, ["areas", i, "folders"]);
      if (area.folders.length > MAX_DECISION_OPTIONS) {
        issue(`area "${area.id}" has ${area.folders.length} folders, but a question accepts at most ${MAX_DECISION_OPTIONS} options: split it into sub-areas (an additional hierarchy level is required)`, ["areas", i, "folders"]);
      }
      const folderIds = new Set<string>();
      area.folders.forEach((folder, j) => {
        if (folderIds.has(folder.id)) issue(`duplicate folder id "${folder.id}" in area "${area.id}"`, ["areas", i, "folders", j, "id"]);
        folderIds.add(folder.id);
        const owner = outlookFolders.get(folder.outlookFolder.toLowerCase());
        if (owner) issue(`Outlook folder "${folder.outlookFolder}" is declared twice (${owner} and ${area.id}/${folder.id})`, ["areas", i, "folders", j, "outlookFolder"]);
        outlookFolders.set(folder.outlookFolder.toLowerCase(), `${area.id}/${folder.id}`);
      });
    });
    if (!areaIds.has(OTHER_AREA_ID)) issue(`an "${OTHER_AREA_ID}" area is required: without a catch-all the engine is forced to pick a wrong area`, ["areas"]);
  });

export type Taxonomy = z.infer<typeof TaxonomySchema>;
export type TaxonomyArea = z.infer<typeof TaxonomyAreaSchema>;
export type TaxonomyFolder = z.infer<typeof TaxonomyFolderSchema>;

/** A validated taxonomy plus its fingerprint (cache keys, audits). */
export interface LoadedTaxonomy {
  taxonomy: Taxonomy;
  /** SHA-256 of the canonical JSON (key order and whitespace independent). */
  hash: string;
  /** Where it came from (file path, or `inline`). */
  source: string;
  /** True when the bundled example is in use. */
  example: boolean;
}

/** Invalid taxonomy: a configuration error, reported like the others at boot. */
export class TaxonomyError extends ConfigError {
  constructor(source: string, problems: string[]) {
    super(problems.map((p) => `LAYA_TAXONOMY_FILE (${source}): ${p}`));
    this.name = "TaxonomyError";
  }
}

/** JSON with object keys sorted recursively: the hash ignores formatting and key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const taxonomyHash = (taxonomy: Taxonomy): string => sha256(canonicalJson(taxonomy));

/** Validate an already-parsed JSON value. Throws `TaxonomyError` listing every problem. */
export function parseTaxonomy(raw: unknown, source = "inline", example = false): LoadedTaxonomy {
  const parsed = TaxonomySchema.safeParse(raw);
  if (!parsed.success) throw new TaxonomyError(source, parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`));
  return { taxonomy: parsed.data, hash: taxonomyHash(parsed.data), source, example };
}

/** Read + validate a taxonomy file. `path` undefined = the bundled example. */
export function loadTaxonomy(path?: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): LoadedTaxonomy {
  const file = path ?? EXAMPLE_TAXONOMY_PATH;
  let text: string;
  try {
    text = read(file);
  } catch (e) {
    throw new TaxonomyError(file, [`cannot read the file (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new TaxonomyError(file, [`not valid JSON (${(e as Error).message})`]);
  }
  return parseTaxonomy(raw, file, path === undefined);
}

/**
 * Largest option count whose confidence the published checkpoints calibrate.
 * Observed on laya 0.3.9 / convaiinnovations/laya@5e7b2b1b: the `english`
 * checkpoint ships an invalid temperature for its `choice:11+` bucket (laya
 * clamps it and warns that the confidence is uncalibrated), and the
 * `multilingual` checkpoint ships no per-option temperature at all.
 */
export const CALIBRATED_MAX_OPTIONS = 10;

/**
 * Non-blocking advice logged at boot: questions that would be asked with more
 * options than the checkpoints calibrate. The file stays valid (≤ 15).
 */
export function taxonomyWarnings(t: Taxonomy): string[] {
  const warnings: string[] = [];
  if (t.areas.length > CALIBRATED_MAX_OPTIONS) {
    warnings.push(`${t.areas.length} business areas: above ${CALIBRATED_MAX_OPTIONS} options the engine's confidence is uncalibrated — consider grouping areas`);
  }
  for (const area of t.areas) {
    if (area.folders.length > CALIBRATED_MAX_OPTIONS) {
      warnings.push(`area "${area.id}" has ${area.folders.length} folders: above ${CALIBRATED_MAX_OPTIONS} options the engine's confidence is uncalibrated — consider sub-areas`);
    }
  }
  return warnings;
}

export const areaById = (t: Taxonomy, id: string): TaxonomyArea | undefined => t.areas.find((a) => a.id === id);

export const folderById = (area: TaxonomyArea, id: string): TaxonomyFolder | undefined => area.folders.find((f) => f.id === id);

export const localize = (value: { fr: string; en: string }, lang: Language): string => (lang === "fr" ? value.fr : value.en);

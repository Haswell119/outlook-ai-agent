/**
 * Client-side planning of a mailbox import (`/integrations`): which picked
 * files are sent, and in which batches. Pure, so the rules are unit-tested.
 */
import { MAILBOX_IMPORT_MAX_FILES } from "@oao/shared";

/** Extensions kept from a folder upload; the orchestrator checks the content anyway. */
export const MAIL_FILE_EXTENSIONS = [".eml", ".msg"] as const;
/** Same bound as the orchestrator (`MAX_MAIL_FILE_BYTES`): larger files are not sent. */
export const MAX_MAIL_FILE_BYTES = 25 * 1024 * 1024;
/**
 * Bytes per request: well under the orchestrator's batch limit and the body
 * buffer of the Next.js middleware, and small enough for one batch to be
 * indexed well within the orchestrator's request timeout.
 */
export const IMPORT_BATCH_BYTES = 8 * 1024 * 1024;
/** Files per request when only indexing (each message is embedded). */
export const IMPORT_BATCH_FILES = Math.min(10, MAILBOX_IMPORT_MAX_FILES);

export const isMailFile = (name: string): boolean => MAIL_FILE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

/** Folder of a file picked with a folder upload (`webkitRelativePath`), without the file name. */
export function folderOf(relativePath: string | undefined): string | undefined {
  if (!relativePath || !relativePath.includes("/")) return undefined;
  const dir = relativePath.slice(0, relativePath.lastIndexOf("/"));
  // The contract caps it at 260 characters; the deepest part is the most telling.
  return dir.length > 260 ? dir.slice(dir.length - 260) : dir || undefined;
}

/**
 * Batches in pick order. With `analyze`, one message per request: each one
 * costs a model call. A file larger than `IMPORT_BATCH_BYTES` travels alone.
 */
export function planBatches<T extends { size: number }>(files: T[], opts: { analyze: boolean }): T[][] {
  const maxFiles = opts.analyze ? 1 : IMPORT_BATCH_FILES;
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length && (current.length >= maxFiles || bytes + file.size > IMPORT_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** One id for every batch of a run, so the audit trail groups them. */
export function newImportId(): string {
  return `imp_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The orchestrator explains a refused file in English (it is an API); the card
 * shows the known reasons in the dashboard's language, and anything else as is.
 */
const REASONS: Array<[RegExp, string]> = [
  [/^empty file$/, "import.reason.empty"],
  [/^larger than /, "import.tooLarge"],
  [/^not an \.eml or \.msg message$/, "import.reason.notMail"],
  [/^not a readable Outlook message/, "import.reason.unreadableMsg"],
  [/^not a readable email/, "import.reason.unreadableEml"],
  [/^no subject and no text/, "import.reason.empty"],
  [/^the file could not be read$/, "import.reason.unreadable"],
  [/^imported, but the analysis failed/, "import.reason.analysisFailed"],
];

export function reasonKey(reason: string): string | undefined {
  return REASONS.find(([pattern]) => pattern.test(reason))?.[1];
}

/** Seconds to wait after a 429, from `Retry-After` (bounded), else 10 s. */
export function retryAfterSeconds(header: string | null): number {
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? Math.min(60, Math.ceil(n)) : 10;
}

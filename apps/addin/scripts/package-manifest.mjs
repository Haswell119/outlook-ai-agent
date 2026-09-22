/**
 * Builds the **Teams app package** for the unified (JSON) manifest.
 *
 *     npm run manifest:package -w @oao/addin          # manifest/manifest.json
 *     npm run manifest:package -w @oao/addin --dev     # manifest/manifest.dev.json
 *     npm run manifest:package -w @oao/addin --out /tmp/app.zip
 *
 * A unified manifest cannot be uploaded on its own: Outlook / Teams expect a
 * **zip** containing `manifest.json` at the root plus the two icons it names
 * (`icons.color`, `icons.outline`). That package is what "Upload a custom app"
 * (Teams client → Apps → Manage your apps, or the Teams admin centre) takes,
 * and it is the only way to get the personal-tab entry in the new Outlook /
 * Outlook on the web "Apps" rail — the classic XML manifest has no equivalent.
 *
 * The icons are generated here from the same vector definition as
 * `public/assets/icon-*.png` (see `icon-png.mjs`): `color.png` at 192x192 and
 * `outline.png` at 32x32, monochrome on transparent as Teams requires.
 *
 * The zip is written by hand (`zlib.deflateRawSync` + the two ZIP headers) so
 * the toolchain keeps its "no native dependency" property, and with a fixed
 * timestamp so two runs of the same manifest produce the same bytes.
 */
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, iconPng } from "./icon-png.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const outArg = argv[argv.indexOf("--out") + 1];
const outFile =
  argv.includes("--out") && outArg ? resolve(process.cwd(), outArg) : join(root, "manifest", dev ? "oao-addin-teams-app.dev.zip" : "oao-addin-teams-app.zip");

const manifestFile = join(root, "manifest", dev ? "manifest.dev.json" : "manifest.json");
const raw = readFileSync(manifestFile, "utf8");
const manifest = JSON.parse(raw);

/* ------------------------------------------------------------ pre-flight ---- */

const problems = [];
if (raw.includes("{{AAD_CLIENT_ID}}")) {
  problems.push("manifest still contains the {{AAD_CLIENT_ID}} placeholder — render it with AAD_CLIENT_ID set, or accept that SSO is off");
}
const colorPath = manifest.icons?.color;
const outlinePath = manifest.icons?.outline;
for (const [key, value] of [
  ["color", colorPath],
  ["outline", outlinePath],
]) {
  if (typeof value !== "string" || !value) problems.push(`icons.${key} is missing from the manifest`);
  else if (/^(https?:)?\/\//.test(value) || value.startsWith("/")) problems.push(`icons.${key} must be a package-relative path, got ${value}`);
}
if (!Array.isArray(manifest.staticTabs) || manifest.staticTabs.length === 0) {
  problems.push("staticTabs is missing — the package would not add the Apps-rail entry");
}
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  // A placeholder client id is a warning (dev packages are fine without SSO);
  // anything else is fatal because the upload would be rejected.
  if (problems.some((p) => !p.startsWith("manifest still contains"))) process.exit(1);
}

/* ------------------------------------------------------------------- zip ---- */

/** Fixed DOS timestamp (1980-01-01 00:00) → byte-identical packages. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 18); // comment length
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ---------------------------------------------------------------- render ---- */

const entries = [
  { name: "manifest.json", data: Buffer.from(raw, "utf8") },
  { name: colorPath, data: iconPng(192, "color") },
  { name: outlinePath, data: iconPng(32, "outline") },
];

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, zip(entries));

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
console.log(
  [
    `Teams app package written: ${outFile} (${kb(readFileSync(outFile).length)})`,
    ...entries.map((e) => `  ${e.name.padEnd(16)} ${kb(e.data.length)}`),
    "",
    `app id ${manifest.id} · version ${manifest.version} · ${manifest.staticTabs?.length ?? 0} personal tab(s)`,
    "",
    "Upload it as a custom app (this is the only way to get the Apps-rail entry):",
    "  · one user  — Outlook/Teams → Apps → Manage your apps → Upload an app → Upload a custom app",
    "  · a tenant  — Teams admin centre → Teams apps → Manage apps → Upload new app",
    "Then, in the new Outlook / Outlook on the web, the app appears in the left Apps bar.",
  ].join("\n"),
);

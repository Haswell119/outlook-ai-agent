/**
 * Generates the add-in icons (blue shield with a check mark) as PNG (16/32/64/80/128)
 * and SVG into public/assets/ — pure Node (zlib), no native dependencies.
 *
 * The rasteriser itself lives in `icon-png.mjs`, which `package-manifest.mjs`
 * reuses for the Teams app package icons (color.png / outline.png).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_SVG, iconPng } from "./icon-png.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets");
mkdirSync(out, { recursive: true });

for (const size of [16, 32, 64, 80, 128]) {
  writeFileSync(join(out, `icon-${size}.png`), iconPng(size, "color"));
}
writeFileSync(join(out, "icon.svg"), ICON_SVG);
console.log("icons written to", out);

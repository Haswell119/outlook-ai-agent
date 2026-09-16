/**
 * The add-in icon (blue shield with a check mark) rasterised in pure Node
 * (zlib only, no native dependency, no canvas).
 *
 * One vector definition, three consumers:
 *   - `generate-icons.mjs`  → public/assets/icon-{16,32,64,80,128}.png (+ icon.svg)
 *   - `package-manifest.mjs`→ color.png (192, Teams app package) and
 *                             outline.png (32, monochrome, the Teams client tints it)
 */
import { deflateSync } from "node:zlib";

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA PNG of `size`x`size`, pixels provided by `pixel(x, y) -> [r,g,b,a]`. */
export function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Shield shape in unit coordinates (0..1): rounded top, pointed bottom. */
export function shield(u, v) {
  // top edge at v=0.08, sides at u=0.12/0.88, bottom point at v=0.96
  if (v < 0.08 || v > 0.96) return false;
  const halfWidth = v < 0.55 ? 0.38 : 0.38 * (1 - Math.pow((v - 0.55) / 0.41, 1.6));
  return Math.abs(u - 0.5) <= halfWidth;
}

/** Two segments of a check mark, thickness ~0.11. */
export function check(u, v) {
  const seg = (ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / l2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return Math.hypot(u - px, v - py);
  };
  return Math.min(seg(0.3, 0.52, 0.45, 0.67), seg(0.45, 0.67, 0.72, 0.36)) < 0.055;
}

export const BLUE = [15, 108, 189];

/**
 * `variant`:
 *   - `"color"`   blue shield, white check mark (the add-in icon)
 *   - `"outline"` white shield with the check knocked out, for the Teams
 *     outline icon which must be monochrome on transparent.
 */
export function iconPixel(size, variant = "color") {
  return (x, y) => {
    // 4x supersampling for smooth edges
    let inS = 0;
    let inC = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const u = (x + (sx + 0.5) / 4) / size;
        const v = (y + (sy + 0.5) / 4) / size;
        if (shield(u, v)) {
          inS++;
          if (check(u, v)) inC++;
        }
      }
    }
    if (!inS) return [0, 0, 0, 0];
    const coverage = inS / 16;
    const t = inC / inS;
    if (variant === "outline") return [255, 255, 255, Math.round(coverage * (1 - t) * 255)];
    const [r, g, b] = BLUE.map((c) => Math.round(c * (1 - t) + 255 * t));
    return [r, g, b, Math.round(coverage * 255)];
  };
}

export function iconPng(size, variant = "color") {
  return png(size, iconPixel(size, variant));
}

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#0F6CBD" d="M12 8h76v47c0 22-19 36-38 41C31 91 12 77 12 55z"/><path fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" d="M30 52l15 15 27-31"/></svg>\n`;

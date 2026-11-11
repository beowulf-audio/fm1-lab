// image.mjs — PPM frames from the emulator: decode, encode to PNG, compare. No dependencies.
import { deflateSync, crc32 } from "node:zlib";

/** @returns {{w:number,h:number,rgb:Buffer}|null} */
export function readPpm(buf) {
  if (!buf) return null;
  const head = buf.subarray(0, 64).toString("latin1");
  const m = head.match(/^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) return null;
  const w = +m[1], h = +m[2];
  return { w, h, rgb: buf.subarray(m[0].length, m[0].length + w * h * 3) };
}

export function png({ w, h, rgb }, scale = 1) {
  const W = w * scale, H = h * scale, row = W * 3 + 1, raw = Buffer.alloc(row * H);
  for (let y = 0; y < H; y++) {
    raw[y * row] = 0;
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) { const s = (sy * w + Math.floor(x / scale)) * 3, d = y * row + 1 + x * 3; raw[d] = rgb[s]; raw[d + 1] = rgb[s + 1]; raw[d + 2] = rgb[s + 2]; }
  }
  const chunk = (t, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(t), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
export const ppmToPng = (buf, scale = 1) => { const i = readPpm(buf); return i ? png(i, scale) : null; };

/** Share of pixels that differ by more than `tol` (0..255) in any channel. */
export function diffShare(a, b, tol = 24) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return 1;
  let n = 0;
  for (let i = 0; i < a.rgb.length; i += 3) if (Math.abs(a.rgb[i] - b.rgb[i]) > tol || Math.abs(a.rgb[i + 1] - b.rgb[i + 1]) > tol || Math.abs(a.rgb[i + 2] - b.rgb[i + 2]) > tol) n++;
  return n / (a.w * a.h);
}

/** Is the screen showing something (not one flat colour)? */
export function hasContent(img) {
  if (!img) return false;
  const r0 = img.rgb[0], g0 = img.rgb[1], b0 = img.rgb[2];
  let diff = 0;
  for (let i = 0; i < img.rgb.length; i += 3) if (Math.abs(img.rgb[i] - r0) + Math.abs(img.rgb[i + 1] - g0) + Math.abs(img.rgb[i + 2] - b0) > 30) diff++;
  return diff / (img.w * img.h) > 0.005;
}

/** Visual diff image: unchanged pixels dimmed, changed ones bright magenta. */
export function diffImage(a, b, tol = 24) {
  const out = Buffer.alloc(a.rgb.length);
  for (let i = 0; i < a.rgb.length; i += 3) {
    const ch = Math.abs(a.rgb[i] - b.rgb[i]) > tol || Math.abs(a.rgb[i + 1] - b.rgb[i + 1]) > tol || Math.abs(a.rgb[i + 2] - b.rgb[i + 2]) > tol;
    if (ch) { out[i] = 255; out[i + 1] = 40; out[i + 2] = 200; } else { out[i] = b.rgb[i] >> 2; out[i + 1] = b.rgb[i + 1] >> 2; out[i + 2] = b.rgb[i + 2] >> 2; }
  }
  return { w: a.w, h: a.h, rgb: out };
}

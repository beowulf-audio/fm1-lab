// gif.mjs — an animated GIF from screen frames ({w, h, rgb}), no dependencies. FM-1 screens use few colours, so one
// palette from the frames' own colours is usually exact (the 255 most used, the rest mapped to the nearest); each frame
// after the first keeps only the rectangle that changed (unchanged pixels transparent), and a frame that changes
// nothing lengthens the one before it.

/** @param {{w:number,h:number,rgb:Buffer}[]} frames  @param {{delayMs?:number, scale?:number, loop?:boolean}} o */
export function gif(frames, { delayMs = 100, scale = 1, loop = true } = {}) {
  frames = frames.filter(Boolean);
  if (!frames.length) return null;
  const W0 = frames[0].w, H0 = frames[0].h, W = W0 * scale, H = H0 * scale;

  // the palette: colours by use (sampled), at most 255; index 255 is transparent
  const count = new Map();
  for (const f of frames) for (let i = 0; i < f.rgb.length; i += 3 * 7) { const c = (f.rgb[i] << 16) | (f.rgb[i + 1] << 8) | f.rgb[i + 2]; count.set(c, (count.get(c) || 0) + 1); }
  const pal = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([c]) => c);
  const index = new Map(pal.map((c, i) => [c, i]));
  const nearest = (c) => {
    let hit = index.get(c); if (hit !== undefined) return hit;
    const r = c >> 16, g = (c >> 8) & 255, b = c & 255; let best = 0, bd = Infinity;
    pal.forEach((p, i) => { const d = (r - (p >> 16)) ** 2 + (g - ((p >> 8) & 255)) ** 2 + (b - (p & 255)) ** 2; if (d < bd) { bd = d; best = i; } });
    index.set(c, best); return best;
  };
  const toIdx = (f) => { const o = new Uint8Array(W0 * H0); for (let i = 0, j = 0; j < o.length; i += 3, j++) o[j] = nearest((f.rgb[i] << 16) | (f.rgb[i + 1] << 8) | f.rgb[i + 2]); return o; };

  const out = [];
  const u16 = (v) => out.push(v & 255, v >> 8);
  const ascii = (s) => { for (const ch of s) out.push(ch.charCodeAt(0)); };
  ascii("GIF89a"); u16(W); u16(H);
  out.push(0xf7, 0, 0);                                  // global colour table, 256 entries
  for (let i = 0; i < 256; i++) { const c = pal[i] ?? 0; out.push(c >> 16, (c >> 8) & 255, c & 255); }
  if (loop) { out.push(0x21, 0xff, 11); ascii("NETSCAPE2.0"); out.push(3, 1, 0, 0, 0); }

  // frames: the first whole, then the changed rectangle; a frame equal to the last adds to its time
  const prevIdx = [];
  let prev = null, pending = null;
  const flush = () => {
    if (!pending) return;
    const { x, y, w, h, px, delay } = pending;
    const d = Math.max(2, Math.round(delay / 10));       // in 1/100 s
    out.push(0x21, 0xf9, 4, 0x05, d & 255, d >> 8, 255, 0);   // disposal: keep, transparent index 255
    out.push(0x2c); u16(x * scale); u16(y * scale); u16(w * scale); u16(h * scale); out.push(0);
    const scaled = new Uint8Array(w * scale * h * scale);
    for (let yy = 0; yy < h * scale; yy++) for (let xx = 0; xx < w * scale; xx++) scaled[yy * w * scale + xx] = px[Math.floor(yy / scale) * w + Math.floor(xx / scale)];
    lzw(scaled, 8, out);
    pending = null;
  };
  for (const f of frames) {
    const cur = toIdx(f);
    if (!prev) { pending = { x: 0, y: 0, w: W0, h: H0, px: cur, delay: delayMs }; prev = cur; continue; }
    let x0 = W0, y0 = H0, x1 = -1, y1 = -1;
    for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) { const k = y * W0 + x; if (cur[k] !== prev[k]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
    if (x1 < 0) { pending.delay += delayMs; continue; }
    flush();
    const w = x1 - x0 + 1, h = y1 - y0 + 1, px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y + y0) * W0 + x + x0; px[y * w + x] = cur[k] === prev[k] ? 255 : cur[k]; }
    pending = { x: x0, y: y0, w, h, px, delay: delayMs };
    prev = cur;
  }
  flush();
  out.push(0x3b);
  return Buffer.from(out);
}

/** GIF's LZW: codes from minCode+1 bits up to 12, a clear code when the table fills; in sub-blocks of 255 bytes. */
function lzw(px, minCode, out) {
  out.push(minCode);
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1, dict = new Map();
  let bits = 0, acc = 0; const bytes = [];
  const emit = (code) => { acc |= code << bits; bits += size; while (bits >= 8) { bytes.push(acc & 255); acc >>>= 8; bits -= 8; } };
  emit(clear);
  let w = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i], key = w * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { w = hit; continue; }
    emit(w);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    w = k;
  }
  emit(w); emit(eoi);
  if (bits > 0) bytes.push(acc & 255);
  for (let i = 0; i < bytes.length; i += 255) { const n = Math.min(255, bytes.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(bytes[i + j]); }
  out.push(0);
}

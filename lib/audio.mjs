// audio.mjs — the emulator's audio (stereo s16le): WAV export, level statistics, spectra, similarity. No dependencies.
import { AUDIO_RATE } from "./emu.mjs";

export function toWav(raw, rate = AUDIO_RATE, ch = 2) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + raw.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(raw.length, 40);
  return Buffer.concat([h, raw]);
}

/** Mono float32 (-1..1) from stereo s16le, optionally a time window in ms. */
export function mono(raw, fromMs = 0, toMs = Infinity, rate = AUDIO_RATE) {
  if (!raw) return new Float32Array(0);
  const frames = Math.floor(raw.length / 4);
  const a = Math.max(0, Math.floor(fromMs * rate / 1000)), b = Math.min(frames, Math.floor(Math.min(toMs, 1e12) * rate / 1000));
  const out = new Float32Array(Math.max(0, b - a));
  for (let i = a; i < b; i++) out[i - a] = (raw.readInt16LE(i * 4) + raw.readInt16LE(i * 4 + 2)) / 65536;
  return out;
}

const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

/** Level statistics of a mono signal. */
export function stats(x, rate = AUDIO_RATE) {
  let peak = 0, sum = 0, clip = 0;
  for (const v of x) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; if (a >= 0.99997) clip++; }
  const win = Math.round(rate * 0.01); let silent = 0, wins = 0;
  for (let i = 0; i + win <= x.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += x[j] * x[j]; wins++; if (db(Math.sqrt(s / win)) < -60) silent++; }
  return { seconds: +(x.length / rate).toFixed(3), peakDb: +db(peak).toFixed(1), rmsDb: +db(Math.sqrt(sum / Math.max(1, x.length))).toFixed(1),
           clippedSamples: clip, silentShare: wins ? +(silent / wins).toFixed(3) : 1, hasSound: peak > 0.003 };
}

/** RMS envelope in dB, one value per `stepMs`. */
export function envelope(x, stepMs = 50, rate = AUDIO_RATE) {
  const n = Math.round(rate * stepMs / 1000), out = [];
  for (let i = 0; i + n <= x.length; i += n) { let s = 0; for (let j = i; j < i + n; j++) s += x[j] * x[j]; out.push(+db(Math.sqrt(s / n)).toFixed(1)); }
  return out;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) { const ar = re[i + j], ai = im[i + j], br = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, bi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ar + br; im[i + j] = ai + bi; re[i + j + len / 2] = ar - br; im[i + j + len / 2] = ai - bi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}

/** Average spectrum in 24 log-spaced bands (60 Hz .. 18 kHz), dB. */
export function bands(x, rate = AUDIO_RATE) {
  const N = 2048, nb = 24, lo = 60, hi = 18000, acc = new Float64Array(nb); let frames = 0;
  const edges = Array.from({ length: nb + 1 }, (_, i) => lo * Math.pow(hi / lo, i / nb));
  for (let off = 0; off + N <= x.length; off += N) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    fft(re, im); frames++;
    for (let k = 1; k < N / 2; k++) { const f = k * rate / N; const b = edges.findIndex((e, i) => f >= e && f < edges[i + 1]); if (b >= 0) acc[b] += re[k] * re[k] + im[k] * im[k]; }
  }
  return Array.from(acc, (v) => +db(Math.sqrt(v / Math.max(1, frames)) / N).toFixed(1));
}

/** Best normalised cross-correlation of b against a within ±maxLagMs (1 = identical waveform). */
export function similarity(a, b, maxLagMs = 60, rate = AUDIO_RATE) {
  const n = Math.min(a.length, b.length); if (n < 1000) return null;
  const ea = energy(a, 0, n), eb = energy(b, 0, n);
  if (ea < 1e-9 && eb < 1e-9) return 1;
  if (ea < 1e-9 || eb < 1e-9) return 0;
  const step = 4, maxLag = Math.round(maxLagMs * rate / 1000);   // decimated for speed, then refined
  let best = -1, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag += step) { const c = corr(a, b, lag, n, 4); if (c > best) { best = c; bestLag = lag; } }
  for (let lag = bestLag - step; lag <= bestLag + step; lag++) { const c = corr(a, b, lag, n, 1); if (c > best) best = c; }
  return +Math.max(0, best).toFixed(4);
}
/**
 * Stale-buffer detector. The audio link plays its DMA buffer halves on a fixed schedule, so a firmware that misses
 * a refill plays the old block again bit for bit. Returns, per lag (frames), the share of non-silent stereo frames
 * that equal the frame `lag` earlier in runs of 16 or more.
 */
export function repeats(raw, fromMs = 0, toMs = Infinity, rate = AUDIO_RATE, lags = null) {
  if (!raw) return new Map();
  const x = new Int32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + (raw.length & ~3)));
  const a = Math.floor(fromMs * rate / 1000), b = Math.min(x.length, Math.floor(Math.min(toMs, 1e12) * rate / 1000));
  const out = new Map();
  for (const L of lags || Array.from({ length: 512 }, (_, i) => 8 + i * 8)) {
    let rep = 0, loud = 0, run = 0;
    for (let i = Math.max(a, L); i < b; i++) {
      const v = x[i];
      if (Math.abs((v << 16) >> 16) < 64 && Math.abs(v >> 16) < 64) { run = 0; continue; }
      loud++;
      if (v === x[i - L]) { if (++run >= 16) rep += run === 16 ? 16 : 1; } else run = 0;
    }
    out.set(L, loud ? rep / loud : 0);
  }
  return out;
}

function energy(x, a, b) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return s; }
function corr(a, b, lag, n, stride) {
  let s = 0, sa = 0, sb = 0;
  for (let i = Math.max(0, -lag); i < n && i + lag < n; i += stride) { const x = a[i], y = b[i + lag]; s += x * y; sa += x * x; sb += y * y; }
  return sa > 0 && sb > 0 ? s / Math.sqrt(sa * sb) : 0;
}

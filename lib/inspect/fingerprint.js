// fingerprint.js — MinHash signatures of decrypted firmware code, for "which known firmware is this like?".
// Shared by the browser and the Node data builder so both compute identical signatures.
//
// Shingles: 16-byte windows at a 4-byte stride (pi32v2 code is 2/4-byte aligned).
// Each shingle -> FNV-1a 32 -> K independent hashes via murmur3's fmix32(h ^ seed_k); signature = per-k minimum.
// Shingles common to many firmwares (the JieLi SDK, shared platform code) are dropped using a stop-list built
// from the whole corpus, so similarity reflects the firmware's own code rather than the libraries every image links.

export const K = 64, WIN = 16, STRIDE = 4;

const SEEDS = new Uint32Array(K);
{ let s = 0x9e3779b9; for (let k = 0; k < K; k++) { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6b43a9b5) >>> 0; SEEDS[k] = s; } }

function fmix32(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16; return h >>> 0;
}

/** FNV-1a hash of every shingle (skipping all-0x00 / all-0xFF filler). */
export function shingleHashes(code) {
  const n = code.length < WIN ? 0 : Math.floor((code.length - WIN) / STRIDE) + 1;
  const out = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    let h = 0x811c9dc5, allSame = true;
    const b0 = code[o];
    for (let j = 0; j < WIN; j++) { const b = code[o + j]; if (b !== b0) allSame = false; h = Math.imul(h ^ b, 0x01000193); }
    if (allSame && (b0 === 0 || b0 === 0xff)) continue;
    out[m++] = h >>> 0;
  }
  return out.subarray(0, m);
}

/** @param {Uint32Array} hashes  @param {(h:number)=>boolean} [isStop] */
export function signature(hashes, isStop) {
  const sig = new Uint32Array(K).fill(0xffffffff);
  let used = 0;
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if (isStop && isStop(h)) continue;
    used++;
    for (let k = 0; k < K; k++) { const v = fmix32(h ^ SEEDS[k]); if (v < sig[k]) sig[k] = v; }
  }
  return { sig, used };
}

// ---- text fingerprints: the firmware's own strings (menu labels, engine names, messages) survive forking and
// recompiling far better than code bytes, whose addresses all shift when anything changes.
export function normString(s) { return s.trim().replace(/\d+/g, "#").replace(/\s+/g, " "); }
export function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193); return h >>> 0; }
/** @param {string[]} strs printable strings from the code  @returns {Uint32Array} distinct token hashes */
export function stringTokens(strs) {
  const set = new Set();
  for (const s of strs) { const n = normString(s); if (n.length >= 6 && /[a-z]{3}/i.test(n)) set.add(fnv(n)); }
  return Uint32Array.from(set);
}

// ---- Bloom filter (compact stop-list for code shingles)
export const BLOOM_K = 5;
function bloomIdx(h, k, m) { return fmix32(h ^ SEEDS[k]) % m; }
export function bloomBuild(hashes, m) {
  const bits = new Uint8Array(Math.ceil(m / 8));
  for (const h of hashes) for (let k = 0; k < BLOOM_K; k++) { const i = bloomIdx(h, k, m); bits[i >> 3] |= 1 << (i & 7); }
  return bits;
}
export function bloomFrom(bits, m) {
  return (h) => { for (let k = 0; k < BLOOM_K; k++) { const i = bloomIdx(h, k, m); if (!(bits[i >> 3] & (1 << (i & 7)))) return false; } return true; };
}
export const bytesToB64 = (u8) => b64(u8), b64ToBytes = (s) => unb64(s);

/** estimated Jaccard similarity of two signatures (0..1) */
export function similarity(a, b) {
  let eq = 0;
  for (let k = 0; k < K; k++) if (a[k] === b[k] && a[k] !== 0xffffffff) eq++;
  return eq / K;
}

// ---- compact encodings for the JSON data files
export function sigToB64(sig) { return b64(new Uint8Array(sig.buffer, sig.byteOffset, sig.byteLength)); }
export function sigFromB64(s) { const u = unb64(s); return new Uint32Array(u.buffer, u.byteOffset, u.byteLength / 4); }

/** sorted Uint32Array stop-list <-> base64, with binary-search membership */
export function stopFromB64(s) {
  const u = unb64(s), a = new Uint32Array(u.buffer, u.byteOffset, u.byteLength / 4);
  return (h) => { let lo = 0, hi = a.length - 1; while (lo <= hi) { const mid = (lo + hi) >>> 1, v = a[mid]; if (v === h) return true; if (v < h) lo = mid + 1; else hi = mid - 1; } return false; };
}
export function stopToB64(sortedU32) { return b64(new Uint8Array(sortedU32.buffer, sortedU32.byteOffset, sortedU32.byteLength)); }

function b64(u8) {
  if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
  let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s);
}
function unb64(s) {
  if (typeof Buffer !== "undefined") { const b = Buffer.from(s, "base64"); return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
  const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
}

// match.js — compare a firmware against the known-firmware index.
import { shingleHashes, signature, similarity, sigFromB64, stringTokens, bloomFrom, b64ToBytes, stopFromB64 } from "./fingerprint.js";
import { strings } from "./analyze.js";

/** Load index + stop-lists (objects already parsed from known.json / stoplist.json). */
export function loadIndex(known, stop) {
  const isStopB = bloomFrom(b64ToBytes(stop.bloom), stop.bloomM);
  const isStopS = stopFromB64(stop.strings);
  const entries = known.entries.map((e) => ({ ...e, _s: sigFromB64(e.sig), _ss: sigFromB64(e.ssig) }));
  const bySha = new Map(entries.map((e) => [e.sha256, e]));
  return { entries, bySha, isStopB, isStopS, generated: known.generated };
}

/** Fingerprint decrypted app code the same way the index was built. */
export function fingerprint(app, index) {
  const b = signature(shingleHashes(app), index.isStopB);
  const s = signature(stringTokens(strings(app, 6)), index.isStopS);
  return { sig: b.sig, ownCode: b.used, ssig: s.sig, ownStrings: s.used };
}

const MIN_STR = 40, MIN_CODE = 1500;

/** Combined similarity: the stronger of the text and the code signal, each only when both sides have enough of it. */
export function score(fp, e) {
  const t = fp.ownStrings >= MIN_STR && e.ownStrings >= MIN_STR ? similarity(fp.ssig, e._ss) : 0;
  const c = fp.ownCode >= MIN_CODE && e.ownCode >= MIN_CODE ? similarity(fp.sig, e._s) : 0;
  return { score: Math.max(t, c), text: t, code: c };
}

/**
 * Closest known firmwares, best per project.
 * @returns Array<{entry, score, text, code}>
 */
export function closest(fp, index, { exclude = null, excludeRepo = null, limit = 6, min = 0.08, includeVendored = false } = {}) {
  const best = new Map();
  for (const e of index.entries) {
    if (e.sha256 === exclude || (excludeRepo && e.repo === excludeRepo)) continue;
    if (e.vendoredCopy && !includeVendored) continue;   // copies bundled inside other repos: used for exact identification only
    const s = score(fp, e);
    if (s.score < min) continue;
    const key = e.repo || e.sha256, cur = best.get(key);
    if (!cur || s.score > cur.score || (s.score === cur.score && !e.vendoredCopy && cur.entry.vendoredCopy)) best.set(key, { entry: e, ...s });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Words for a score, calibrated on the corpus (unrelated projects: median 0.00, 99th percentile ~0.06-0.11). */
export function strength(x) {
  if (x >= 0.6) return "near-identical";
  if (x >= 0.3) return "close relative";
  if (x >= 0.15) return "shares a lot of code";
  return "some shared code";
}

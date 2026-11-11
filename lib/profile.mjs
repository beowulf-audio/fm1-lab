// profile.mjs — where does a firmware's CPU time go, and how much headroom does it have on the real chip?
//
// Hotspots: one cycle-accurate run (FM1_STRICT) with fm1-emu's time profiler (FM1_TPROF): time-weighted PC samples of
//   both cores over the scenario's active part (wait loops included), grouped into code regions (or named functions,
//   given a symbol file). The profile is flat: where time is spent, not call chains.
//
// Headroom: the scenario again, cycle-accurately, at lower CPU clocks. Timers, the audio link and MIDI keep real
//   time, so a firmware that runs out of CPU misses audio refills (stale blocks repeat), drops voices or steps (the
//   level falls) or garbles its output (the spectrum moves). A clock "keeps up" when none of that happens.
//   Headroom = 1 - (lowest clock that keeps up) / 240 MHz.
//   Two effects that are not overload are allowed for:
//     - boot is CPU-bound (it takes 4x as long at 60 MHz), so the scenario is delayed by the extra boot time at each
//       clock: otherwise its first inputs land before the firmware is listening;
//     - when the firmware notices an input depends on where its main loop is, so the audio can shift by a few ms;
//       the comparison is by level and spectrum, not by waveform.
import { readFileSync } from "node:fs";
import { runScenario } from "./run.mjs";
import { mono, stats, bands, repeats } from "./audio.mjs";
import { XIP_BASE, RAM_BASE } from "./emu.mjs";

const CLOCKS = [180, 120, 90, 60, 45, 30, 20];
const TOL = { rmsDb: 1.0, bandDb: 2.0, stale: 0.005 };

/** Parse FM1_TPROF output: "core 0xADDR samples" and "mCORE 0xLINE misses". */
export function parseTprof(text) {
  const pcs = [[], []], misses = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([01]) 0x([0-9a-f]+) (\d+)$/); if (m) { pcs[+m[1]].push([parseInt(m[2], 16), +m[3]]); continue; }
    const x = line.match(/^m([01]) 0x([0-9a-f]+) (\d+)$/); if (x) misses.push({ core: +x[1], line: parseInt(x[2], 16), n: +x[3] });
  }
  return { pcs, misses };
}

/** Symbols from `nm`-style lines ("0200a4dc T name") or "0x0200a4dc name". */
export function loadSymbols(path) {
  const syms = [];
  for (const l of readFileSync(path, "utf8").split("\n")) {
    const m = l.trim().match(/^(?:0x)?([0-9a-fA-F]{6,16})\s+(?:[A-Za-z]\s+)?([^\s]+)$/);
    if (m) syms.push([parseInt(m[1], 16), m[2]]);
  }
  return syms.sort((a, b) => a[0] - b[0]);
}
function symbolFor(syms, addr) {
  let lo = 0, hi = syms.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (syms[mid][0] <= addr) { best = syms[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best ? best[1] : null;
}
const area = (a) => (a >= XIP_BASE && a < XIP_BASE + 0x0100_0000 ? "flash" : a >= RAM_BASE && a < RAM_BASE + 0x0008_0000 ? "RAM" : "other");
const hex = (a) => `0x${a.toString(16).padStart(8, "0")}`;

/** Group PC samples into regions (gaps > `gap` bytes split) or into symbols. */
export function hotspots(pcs, syms = null, gap = 64, top = 15) {
  const total = pcs.reduce((s, [, n]) => s + n, 0);
  if (!total) return { total: 0, busyShare: null, running: false, regions: [] };
  const groups = new Map();
  if (syms?.length) {
    for (const [a, n] of pcs) {
      const k = symbolFor(syms, a) || hex(a);
      const g = groups.get(k) || { name: k, from: a, to: a, n: 0 };
      g.n += n; g.from = Math.min(g.from, a); g.to = Math.max(g.to, a); groups.set(k, g);
    }
  } else {
    let cur = null;
    for (const [a, n] of [...pcs].sort((x, y) => x[0] - y[0])) {
      if (!cur || a - cur.to > gap) { cur = { from: a, to: a, n: 0 }; groups.set(a, cur); }
      cur.to = a; cur.n += n;
    }
    for (const g of groups.values()) g.name = `${hex(g.from)}–${hex(g.to)}`;
  }
  const regions = [...groups.values()].sort((x, y) => y.n - x.n).slice(0, top).map((g) => {
    const share = g.n / total;
    return { name: g.name, from: hex(g.from), to: hex(g.to), bytes: g.to - g.from + 2, area: area(g.from), share: +share.toFixed(4),
             // a few instructions holding most of a core's time: almost always a wait loop (idle, or polling a flag)
             likelyWait: share > 0.3 && g.to - g.from <= 128 };
  });
  const waiting = regions.filter((r) => r.likelyWait).reduce((s, r) => s + r.share, 0);
  return { total, busyShare: +(1 - waiting).toFixed(3), running: true, regions };
}

/** Does `test` sound like `ref` (level, spectrum, no stale blocks beyond what ref has)? */
export function compareAudio(ref, test) {
  const rs = stats(ref.x), ts = stats(test.x), rb = ref.bands || bands(ref.x), tb = bands(test.x);
  const used = rb.map((v, i) => i).filter((i) => rb[i] > -90);
  const bandDb = used.length ? used.reduce((s, i) => s + Math.abs(tb[i] - rb[i]), 0) / used.length : 0;
  let stale = 0, staleLag = null;
  for (const [L, share] of test.rep) { const ex = share - (ref.rep.get(L) || 0); if (ex > stale) { stale = ex; staleLag = L; } }
  const rmsDb = ts.rmsDb - rs.rmsDb;
  const why = [];
  if (Math.abs(rmsDb) > TOL.rmsDb) why.push(`level ${rmsDb > 0 ? "+" : ""}${rmsDb.toFixed(1)} dB`);
  if (bandDb > TOL.bandDb) why.push(`spectrum off by ${bandDb.toFixed(1)} dB`);
  if (stale > TOL.stale) why.push(`${(stale * 100).toFixed(1)}% stale audio blocks (every ${staleLag} frames)`);
  return { rmsDb: +rmsDb.toFixed(2), bandDb: +bandDb.toFixed(2), stale: +stale.toFixed(4), ok: why.length === 0, why };
}

const shifted = (sc, d) => (d ? { ...sc, ms: sc.ms + d, steps: sc.steps.map((s) => ({ ...s, at: s.at + d })) } : sc);

/**
 * @param {string} fwsc  @param {object} sc  a normalized scenario
 * @param {{syms?:string, clocks?:number[], sandbox?:boolean, onProgress?:Function}} o
 */
export async function profile(fwsc, sc, o = {}) {
  const firstInput = sc.steps.find((s) => s.kind !== "screenshot")?.at ?? 1000;
  const from = Math.max(500, Math.min(firstInput, sc.ms - 1000)), to = sc.ms - 100;
  const syms = o.syms ? loadSymbols(o.syms) : null;
  const progress = o.onProgress || (() => {});

  progress(`hotspots: cycle-accurate run at 240 MHz (${from}–${to} ms)`);
  const ref = await runScenario(fwsc, sc, { strict: true, mhz: 240, tprof: [from, to], sandbox: o.sandbox });
  if (ref.exitCode !== 0 || ref.fault) throw new Error(`the 240 MHz reference run failed: ${ref.fault || `exit ${ref.exitCode}`}`);
  const tp = ref._raw.tprof ? parseTprof(ref._raw.tprof) : { pcs: [[], []], misses: [] };
  const cores = [0, 1].map((c) => hotspots(tp.pcs[c], syms));
  const boot = ref.screen.firstContentMs ?? 300;
  const audioOf = (r, d) => { const x = mono(r._raw.audio, from + d, to + d); return { x, bands: bands(x), rep: repeats(r._raw.audio, from + d, to + d) }; };

  // Inputs can land at a moment the firmware treats specially (a key scan, a preset still loading), so the same
  // scenario a few ms later may sound different even at full speed. Overload doesn't depend on that phase, so every
  // clock is measured at two input phases and keeps up when either matches either reference.
  const PHASE = 37;
  progress(`reference at 240 MHz, inputs ${PHASE} ms later`);
  const ref2 = await runScenario(fwsc, shifted(sc, PHASE), { strict: true, mhz: 240, sandbox: o.sandbox });
  const refs = [audioOf(ref, 0), audioOf(ref2, PHASE)];
  const audible = stats(refs[0].x).hasSound;
  const phaseSensitive = audible && !compareAudio(refs[0], refs[1]).ok;

  const steps = [{ mhz: 240, shiftMs: 0, keepsUp: true }];
  const measure = async (mhz, d) => {
    const r = await runScenario(fwsc, shifted(sc, d), { strict: true, mhz, sandbox: o.sandbox });
    const a = audioOf(r, d);
    const cmp = refs.map((rf) => compareAudio(rf, a)).sort((x, y) => x.why.length - y.why.length || x.bandDb - y.bandDb)[0];
    const why = [...cmp.why];
    if (r.exitCode !== 0 || r.fault) why.unshift(r.fault || `exit ${r.exitCode}`);
    if (r.screen.firstContentMs != null && r.screen.firstContentMs > boot + d) why.push(`still booting when the scenario started (${r.screen.firstContentMs} ms)`);
    return { mhz, shiftMs: d, keepsUp: why.length === 0, rmsDb: cmp.rmsDb, bandDb: cmp.bandDb, stale: cmp.stale, why };
  };
  const tryClock = async (mhz) => {
    // the extra boot time at this clock (boot scales ~1/clock), rounded up to a frame, plus a margin
    const d = Math.ceil(boot * (240 / mhz - 1) / 16) * 16 + 160;
    progress(`headroom: ${mhz} MHz (scenario delayed ${d} ms for the slower boot)`);
    let s = await measure(mhz, d);
    if (!s.keepsUp) {
      progress(`headroom: ${mhz} MHz again, inputs ${PHASE} ms later`);
      const s2 = await measure(mhz, d + PHASE);
      if (s2.keepsUp) s = { ...s2, phaseDependent: true };
    }
    steps.push(s); return s;
  };

  if (audible) {
    let lastOk = 240, firstFail = null;
    for (const mhz of (o.clocks || CLOCKS).filter((c) => c < 240)) {
      if ((await tryClock(mhz)).keepsUp) lastOk = mhz; else { firstFail = mhz; break; }
    }
    if (firstFail && lastOk - firstFail > 10) {   // one bisection step
      const mid = Math.round((lastOk + firstFail) / 2 / 5) * 5;
      if ((await tryClock(mid)).keepsUp) lastOk = mid; else firstFail = mid;
    }
    steps.sort((a, b) => b.mhz - a.mhz);
    var headroom = {
      neededMhz: firstFail ? [firstFail, lastOk] : [null, lastOk],
      headroomShare: +(1 - lastOk / 240).toFixed(3),
      note: firstFail
        ? `keeps up at ${lastOk} MHz; at ${firstFail} MHz: ${steps.find((s) => s.mhz === firstFail).why.join(", ")}`
        : `keeps up even at ${lastOk} MHz, the lowest clock tried`,
      phaseSensitive,
      ...(phaseSensitive ? { warning: "the scenario sounds different when its inputs move by a few ms, even at full speed: start inputs later (after the firmware has settled) or spread out simultaneous notes" } : {}),
      steps,
    };
  } else {
    var headroom = { neededMhz: null, headroomShare: null, steps,
                     note: "the scenario makes no sound, so there are no audio deadlines to measure: play something in it" };
  }

  return {
    tool: "fm1-lab profile", firmware: fwsc.split("/").pop(), scenario: sc.name, window: [from, to],
    headroom, hotspots: { core0: cores[0], core1: cores[1], symbols: !!syms },
    cacheMisses: tp.misses.sort((a, b) => b.n - a.n).slice(0, 10).map((m) => ({ core: m.core, line: hex(m.line), misses: m.n })),
    isrShare: ref.isrShare, bootMs: boot,
    _ref: ref,
  };
}

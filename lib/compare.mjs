// compare.mjs — two firmware builds, the same input: what changed in sound, screen, flash use and CPU, and is any of
// it a regression?
//
// Differences are reported; regressions decide the exit code. A regression is B being worse than A in a way that is
// rarely intended: a new fault, a scenario check A passed and B fails, sound that went silent, new clipping, stale
// audio blocks (missed refills), saving that stopped or flash use that collapsed, or (with headroom) less CPU to spare.
// A change in tone or screen layout is a difference, not a regression, unless `identical` is asked for (a refactor
// that should change nothing).
//
// Timing: when a firmware notices an input depends on where its main loop is, and two builds place their code
// differently, so an input can land a little differently (a fast knob turn accelerated more, a note a frame later).
// When the first comparison finds anything, both builds run again with every input 37 ms later, and only what is
// found both times counts; the rest is listed as timing-dependent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { runScenario } from "./run.mjs";
import { mono, stats, bands, repeats, similarity } from "./audio.mjs";
import { diffShare, diffImage, png } from "./image.mjs";
import { profile } from "./profile.mjs";
import { checkPackage } from "./check.mjs";

const TOL = { rmsDb: 1.0, bandDb: 2.0, stale: 0.005, screen: 0.002, bootSlower: 1.5, headroomDrop: 0.1 };
const PHASE_MS = 37;

const shifted = (sc, d) => (d ? { ...sc, ms: sc.ms + d, steps: sc.steps.map((s) => ({ ...s, at: s.at + d })) } : sc);

/**
 * @param {string} a  baseline .fwsc   @param {string} b  candidate .fwsc   @param {object} sc  a normalized scenario
 * @param {{out?:string, strict?:boolean, headroom?:boolean, identical?:boolean, retry?:boolean, sandbox?:boolean,
 *          onProgress?:Function}} o
 */
export async function compare(a, b, sc, o = {}) {
  const progress = o.onProgress || (() => {});
  const runPair = async (d) => {
    const s = shifted(sc, d), tag = d ? ` (inputs ${d} ms later)` : "";
    progress(`running ${basename(a)}${tag}`);
    const ra = await runScenario(a, s, { strict: o.strict, sandbox: o.sandbox });
    progress(`running ${basename(b)}${tag}`);
    const rb = await runScenario(b, s, { strict: o.strict, sandbox: o.sandbox });
    return { ra, rb, ...analyze(ra, rb, s, d ? null : o.out) };
  };

  const first = await runPair(0);
  let regs = first.regs, difs = first.difs, timingOnly = [], second = null;
  const hasFindings = (x) => x.regs.length || x.difs.some((f) => f.key !== "audio-bits");
  if (o.retry !== false && hasFindings(first)) {
    second = await runPair(PHASE_MS);
    const keys = new Set([...second.regs, ...second.difs].map((f) => f.key));
    const keysFirst = new Set([...first.regs, ...first.difs].map((f) => f.key));
    regs = first.regs.filter((f) => keys.has(f.key));
    difs = first.difs.filter((f) => keys.has(f.key));
    timingOnly = [...first.regs, ...first.difs].filter((f) => !keys.has(f.key))
      .concat([...second.regs, ...second.difs].filter((f) => !keysFirst.has(f.key)));
  }

  const cpu = { ...first.cpu };
  if (o.headroom) {
    progress(`headroom of ${basename(a)}`); const pa = await profile(a, sc, { sandbox: o.sandbox, onProgress: progress });
    progress(`headroom of ${basename(b)}`); const pb = await profile(b, sc, { sandbox: o.sandbox, onProgress: progress });
    cpu.headroomA = pa.headroom.headroomShare; cpu.headroomB = pb.headroom.headroomShare;
    cpu.headroomNote = { a: pa.headroom.note, b: pb.headroom.note };
    if (cpu.headroomA != null && cpu.headroomB != null) {
      if (cpu.headroomA - cpu.headroomB > TOL.headroomDrop)
        regs.push({ key: "headroom-drop", msg: `B has less CPU headroom (${Math.round(cpu.headroomB * 100)}% vs ${Math.round(cpu.headroomA * 100)}%)` });
      if (cpu.headroomA !== cpu.headroomB)
        difs.push({ key: "headroom", msg: `CPU headroom ${Math.round(cpu.headroomA * 100)}% → ${Math.round(cpu.headroomB * 100)}%` });
    }
  }
  // size: the app in its slot (both packages through FM-1 Inspect's decoder)
  const ca = checkPackage(a), cb = checkPackage(b);
  const size = { a: ca.appBytes, b: cb.appBytes, slotA: ca.appSlot, slotB: cb.appSlot };
  if (ca.ok && cb.ok && ca.appBytes !== cb.appBytes) {
    const d = cb.appBytes - ca.appBytes;
    difs.push({ key: "size", msg: `app size ${ca.appBytes.toLocaleString("en")} → ${cb.appBytes.toLocaleString("en")} B (${d > 0 ? "+" : ""}${d.toLocaleString("en")}; ${Math.round((cb.appBytes / Math.max(1, cb.appSlot)) * 100)}% of its slot)` });
  }
  if (o.identical) for (const d of difs) if (d.key !== "audio-bits") regs.push({ key: `identical:${d.key}`, msg: `(identical asked) ${d.msg}` });

  const regressions = regs.map((f) => f.msg), differences = difs.map((f) => f.msg);
  const result = {
    tool: "fm1-lab compare", a: basename(a), b: basename(b), scenario: sc.name, ms: sc.ms, strict: !!o.strict,
    verdict: regressions.length ? "regression" : differences.length ? "different" : "same",
    regressions, differences, timingDependent: timingOnly.map((f) => f.msg), retried: !!second,
    audio: first.audio, screens: first.screens, flash: first.flash, cpu, size,
    checks: { a: first.ra.checks, b: first.rb.checks },
  };
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    writeFileSync(join(o.out, "compare.json"), JSON.stringify(result, null, 2));
  }
  result._runs = { a: first.ra, b: first.rb };
  return result;
}

/** One pair of runs: the measurements, and the findings as {key, msg} (keys are stable across retries). */
function analyze(ra, rb, sc, out) {
  // audio, from the first input on
  const from = sc.steps.find((s) => s.kind !== "screenshot")?.at ?? 0, to = sc.ms;
  const xa = mono(ra._raw.audio, from, to), xb = mono(rb._raw.audio, from, to);
  const sa = stats(xa), sb = stats(xb), ba = bands(xa), bb = bands(xb);
  const used = ba.map((_, i) => i).filter((i) => ba[i] > -90 || bb[i] > -90);
  const bandDelta = ba.map((v, i) => +(bb[i] - v).toFixed(1));
  const bandDb = used.length ? used.reduce((s, i) => s + Math.abs(bandDelta[i]), 0) / used.length : 0;
  const repA = repeats(ra._raw.audio, from, to), repB = repeats(rb._raw.audio, from, to);
  let stale = 0, staleLag = null;
  for (const [L, v] of repB) { const ex = v - (repA.get(L) || 0); if (ex > stale) { stale = ex; staleLag = L; } }
  const identicalAudio = !!(ra._raw.audio && rb._raw.audio && ra._raw.audio.equals(rb._raw.audio));
  const audio = {
    identical: identicalAudio,
    a: sa, b: sb,
    rmsDb: +(sb.rmsDb - sa.rmsDb).toFixed(2), peakDb: +(sb.peakDb - sa.peakDb).toFixed(2), bandDb: +bandDb.toFixed(2), bandDelta,
    similarity: identicalAudio ? 1 : similarity(xa, xb),   // waveform match (shifts by a few ms of timing lower it)
    staleExcess: +stale.toFixed(4), staleLag,
  };

  // screens: each named screenshot and the end
  const shotsA = new Map(ra._raw.shots.map((s) => [s.name, s])), screens = [];
  for (const sB of rb._raw.shots) {
    const sA = shotsA.get(sB.name); if (!sA?.img || !sB.img) continue;
    const d = diffShare(sA.img, sB.img);
    screens.push({ name: sB.name, at: sB.at, changed: +d.toFixed(4) });
    if (out && d > TOL.screen && sA.img.w === sB.img.w && sA.img.h === sB.img.h) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${sB.name}.a.png`), png(sA.img, 2));
      writeFileSync(join(out, `${sB.name}.b.png`), png(sB.img, 2));
      writeFileSync(join(out, `${sB.name}.diff.png`), png(diffImage(sA.img, sB.img), 2));
    }
  }

  const flash = { a: ra.flashOps, b: rb.flashOps };
  const cpu = { isrShareA: ra.isrShare, isrShareB: rb.isrShare, bootMsA: ra.screen.firstContentMs, bootMsB: rb.screen.firstContentMs };

  const regs = [], difs = [];
  const reg = (key, msg) => regs.push({ key, msg }), dif = (key, msg) => difs.push({ key, msg });
  if (rb.fault && !ra.fault) reg("fault", `B faults: ${rb.fault}`);
  if (rb.exitCode !== 0 && ra.exitCode === 0) reg("exit", `B's emulator run failed (exit ${rb.exitCode})`);
  const checksA = new Map(ra.checks.map((c) => [c.name, c]));
  for (const c of rb.checks) if (!c.ok && checksA.get(c.name)?.ok) reg(`check:${c.name}`, `check "${c.name}" passes on A, fails on B: ${c.detail}`);
  if (ra.screen.booted && !rb.screen.booted) reg("blank", "B's screen stays blank");
  if (sa.hasSound && !sb.hasSound) reg("silent", "B is silent where A makes sound");
  if (sb.clippedSamples > 0 && sa.clippedSamples === 0) reg("clipping", `B clips (${sb.clippedSamples} samples)`);
  if (stale > TOL.stale) reg("stale", `B plays ${(stale * 100).toFixed(1)}% stale audio blocks (every ${staleLag} frames): it misses audio refills`);
  const opsA = flash.a.reads + flash.a.writes, opsB = flash.b.reads + flash.b.writes;
  if (flash.a.writes > 0 && flash.b.writes === 0) reg("flash-writes", `B never writes its flash (A: ${flash.a.writes} writes): saving stopped`);
  else if (opsA >= 10 && opsB <= opsA * 0.1) reg("flash-collapse", `B's flash use collapsed (${opsA} → ${opsB} operations): its storage may not work on this flash chip`);

  if (!identicalAudio) {
    if (Math.abs(audio.rmsDb) > TOL.rmsDb) dif("level", `level ${audio.rmsDb > 0 ? "+" : ""}${audio.rmsDb} dB`);
    if (bandDb > TOL.bandDb) {
      const top = [...used].sort((i, j) => Math.abs(bandDelta[j]) - Math.abs(bandDelta[i])).slice(0, 3).map((i) => `${bandHz(i)} Hz ${bandDelta[i] > 0 ? "+" : ""}${bandDelta[i]} dB`);
      dif("spectrum", `spectrum differs by ${bandDb.toFixed(1)} dB on average (most: ${top.join(", ")})`);
    }
    if (!difs.length) dif("audio-bits", `audio not bit-identical but sounds the same (waveform match ${audio.similarity})`);
  }
  for (const s of screens) if (s.changed > TOL.screen) dif(`screen:${s.name}`, `screen "${s.name}": ${(s.changed * 100).toFixed(1)}% of pixels changed`);
  // with a screen reader on: what each screenshot says, A against B
  for (const sB of rb._raw.shots) {
    const sA = shotsA.get(sB.name);
    if (sA?.said != null && sB.said != null && sA.said !== sB.said) dif(`said:${sB.name}`, `screen "${sB.name}" reads "${sB.said}" (A: "${sA.said}")`);
  }
  // everything the screen reader heard, in order (WHERE's whole-screen readouts and the announcements as things change)
  if (ra.usb?.said?.length || rb.usb?.said?.length) {
    const ta = (ra.usb?.said || []).map((x) => x.text), tb = (rb.usb?.said || []).map((x) => x.text);
    const i = ta.findIndex((t, k) => t !== tb[k]), j = i < 0 && ta.length !== tb.length ? Math.min(ta.length, tb.length) : i;
    if (j >= 0) dif("said", `the screen reader heard something else: "${tb[j] ?? "(nothing)"}" where A said "${ta[j] ?? "(nothing)"}" (${ta.length} → ${tb.length} things said)`);
  }
  // MIDI out over USB
  if (ra.usb && rb.usb) {
    const ma = ra.usb.midiOut.map((m) => m.hex).join("|"), mb = rb.usb.midiOut.map((m) => m.hex).join("|");
    if (ma !== mb) dif("midi-out", `MIDI out over USB differs: ${ra.usb.midiOut.length} → ${rb.usb.midiOut.length} messages`);
  }
  if (flash.a.writes !== flash.b.writes || flash.a.reads !== flash.b.reads) dif("flash-ops", `flash: ${flash.a.reads}/${flash.a.writes} → ${flash.b.reads}/${flash.b.writes} reads/writes`);
  if (cpu.bootMsA != null && cpu.bootMsB != null && cpu.bootMsB > Math.max(cpu.bootMsA * TOL.bootSlower, cpu.bootMsA + 200))
    dif("boot", `boots slower: first screen at ${cpu.bootMsB} ms (A: ${cpu.bootMsA} ms)`);
  if (ra.isrShare != null && rb.isrShare != null && Math.abs(rb.isrShare - ra.isrShare) >= 0.03)
    dif("isr", `interrupt time ${Math.round(ra.isrShare * 100)}% → ${Math.round(rb.isrShare * 100)}% of core 0`);

  return { audio, screens, flash, cpu, regs, difs };
}

const bandHz = (i) => Math.round(60 * Math.pow(18000 / 60, (i + 0.5) / 24));

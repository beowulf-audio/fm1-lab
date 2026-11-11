// fm1-lab's unit tests: fast, no emulator, no build. node --test tests/unit.test.mjs (npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalize, toKeys, loadScenario } from "../lib/scenario.mjs";
import { translate, evaluate, BOOT_MS } from "../lib/hostscript.mjs";
import { parseUsb } from "../lib/run.mjs";
import { stats, repeats, similarity, mono, toWav } from "../lib/audio.mjs";
import { describeSizes } from "../lib/sizes.mjs";
import { checkPackage, describe } from "../lib/check.mjs";
import { readPpm, png, diffShare, hasContent } from "../lib/image.mjs";
import { parseTprof, hotspots } from "../lib/profile.mjs";
import { gif } from "../lib/gif.mjs";

// ---- scenarios
test("scenario: notes on the keyboard, and off it", () => {
  const sc = normalize({ steps: [{ at: 100, note: "F3" }, { at: 200, note: "G5", vel: 200 }, { at: 300, note: "n26" }] });
  assert.deepEqual(sc.steps.map((s) => s.key), ["F3", "G5", "n26"]);
  assert.equal(sc.steps[1].vel, 127, "velocity clamped");
  assert.throws(() => normalize({ steps: [{ at: 1, note: "E3" }] }), /off the FM-1's keyboard/);
  assert.throws(() => normalize({ steps: [{ at: 1, note: "A5" }] }), /off the FM-1's keyboard/);
  assert.throws(() => normalize({ steps: [{ at: 1, press: "BOGUS" }] }), /unknown button/);
  assert.throws(() => normalize({ ms: 100, steps: [{ at: 50, note: "C4", hold: 300 }] }), /run past "ms"/);
});

test("scenario: click_ms spreads a turn into single clicks", () => {
  const sc = normalize({ click_ms: 250, steps: [{ at: 1000, turn: "KNOB1", clicks: -3 }] });
  assert.deepEqual(sc.steps.map((s) => [s.at, s.clicks, s.enc]), [[1000, -1, 2], [1250, -1, 2], [1500, -1, 2]]);
  const burst = normalize({ steps: [{ at: 1000, turn: "KNOB1", clicks: -3 }] });
  assert.equal(burst.steps.length, 1);
  assert.equal(burst.steps[0].clicks, -3);
});

test("scenario: the key script fm1-live reads", () => {
  const sc = normalize({ steps: [{ at: 100, press: "OCT+", hold: 50 }, { at: 200, note: "C4", vel: 90, hold: 100 }, { at: 400, turn: "PRESETS", clicks: 2 },
                                 { at: 500, pot: 2000 }, { at: 600, midi: "90 3c 64" }, { at: 700, usb_midi: "80 3c 00" }] });
  assert.equal(toKeys(sc), "100:OCTUP,150:OCTUP^,200:C4@90,300:C4^,400:e6:+2,500:pot:1023,600:m903c64");   // usb_midi goes over USB, not here
});

test("scenario: usb and reader switch themselves on", () => {
  assert.equal(normalize({ steps: [] }).usb, false);
  const s = normalize({ steps: [], expect: { said: "X" } });
  assert.equal(s.reader, true); assert.equal(s.usb, true);
  assert.equal(normalize({ steps: [{ at: 1, usb_midi: "f8" }] }).usb, true);
});

// ---- fm1-base host scripts
const SCRIPT = `wait 600
shot boot.png
key 7 down
wait 50
expect note 60
expect midi_out 1
key 7 up
tap OCT+
turn K1 2
master 4096
midi TRS 90 3C 64
midi USB 80 3C 00
listen
wait 100
said HELLO
# fm1-lab: simulator only
said BLE THING
# fm1-lab: end
reboot
expect peak_db_min -30`;

test("host script: inputs at the simulator's timings, after the device's boot", () => {
  const t = translate(SCRIPT);
  const st = normalize(t.raw).steps.filter((s) => s.kind !== "screenshot");
  const at = (k) => st.find(k).at;
  assert.equal(at((s) => s.kind === "note"), BOOT_MS + 600);
  assert.equal(st.find((s) => s.kind === "note").hold, 52);
  assert.equal(at((s) => s.kind === "press"), BOOT_MS + 654);
  const turns = st.filter((s) => s.kind === "turn");
  assert.deepEqual(turns.map((s) => [s.at - BOOT_MS, s.clicks, s.enc]), [[734, 1, 2], [814, 1, 2]], "K1 = encoder 2, clicks 80 ms apart");
  assert.equal(st.find((s) => s.kind === "pot").value, 1023, "master 4096 -> pot 1023");
  assert.ok(st.find((s) => s.kind === "midi" && s.hex === "903c64"), "TRS MIDI");
  assert.ok(st.find((s) => s.kind === "usb_midi" && s.hex === "803c00"), "USB MIDI");
  // 600 + key 2 + 50 + key up 2 + tap 80 + two clicks 160 + master 40 + two MIDI 4 = 938 ms into the script
  assert.equal(t.raw.reader_from, BOOT_MS + 938, "the reader starts at listen");
});

test("host script: what the emulator checks, and what stays the simulator's", () => {
  const t = translate(SCRIPT);
  assert.deepEqual(t.timed.map((x) => x.kind + (x.what ? ":" + x.what : "")), ["expect:midi_out", "said", "expect:peak_db_min"]);
  const why = Object.fromEntries(t.skipped.map((s) => [s.text, s.why]));
  assert.match(why["expect note 60"], /app's own state/);
  assert.match(why["said BLE THING"], /marked simulator only/);
  assert.match(why["reboot"], /no emulator counterpart/);
  const mo = t.timed[0];
  assert.equal(mo.until, BOOT_MS + 652 + 10, "the window ends 10 ms after the next input (the key's release)");
});

test("host script: evaluating against a run", () => {
  const t = translate("wait 100\nkey 7 down\nwait 50\nexpect midi_out 1\nkey 7 up\nlisten\nwait 100\nsaid OCTAVE +1\nunsaid ERROR\nwait 100\nsaid_none");
  const L = BOOT_MS;
  const run = { usb: { said: [{ ms: L + 160, text: "HELLO. OCTAVE +1" }], midiOut: [{ ms: L + 117, hex: "90 3c 5a" }, { ms: L + 167, hex: "80 3c 00" }] }, _raw: { audio: null } };
  const res = evaluate(t.timed, run);
  assert.deepEqual(res.map((r) => r.ok), [true, true, true, true], res.map((r) => r.detail).join(" / "));
  run.usb.said.push({ ms: L + 300, text: "ERROR" });
  assert.equal(evaluate(t.timed, run)[3].ok, false, "said_none fails when something was said");
});

// ---- the emulated computer on USB
test("USB log: screen reader, MIDI out, enumeration", () => {
  const hex = (s) => [...Buffer.from(s, "latin1")].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const log = [
    `[   407 ms] usb: Configured { product: "HELLO FM-1", vid: 4617, pid: 1 }`,
    `[  1503 ms] usb in:  f0 7d 53 52 01 01 ${hex("HELLO DEV")} 00 ${hex("https://x/w.json")} f7`,
    `[  1513 ms] usb in:  f0 7d 53 52 10 01 ${hex("HELLO. OCTAVE +0")} f7`,
    `[  2018 ms] usb in:  90 3c 5a`,
    `[  2100 ms] usb out: f0 7d 53 52 03 f7`,
    `[  2200 ms] usb out: 90 40 64`,                 // MIDI the computer sent: not the device's MIDI out
  ].join("\n");
  const u = parseUsb(log);
  assert.equal(u.configured, "HELLO FM-1");
  assert.deepEqual(u.reader, { name: "HELLO DEV", words: "https://x/w.json" });
  assert.deepEqual(u.said, [{ ms: 1513, flags: 1, text: "HELLO. OCTAVE +0" }]);
  assert.deepEqual(u.midiOut, [{ ms: 2018, hex: "90 3c 5a" }], "only the device's messages, not what the computer sent");
});

// ---- audio
const AR = 44118;
function stereo(fn, seconds) {
  const n = Math.round(AR * seconds), b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { const v = Math.round(fn(i) * 20000); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2); }
  return b;
}
test("audio: level, silence, similarity", () => {
  const sine = stereo((i) => Math.sin((2 * Math.PI * 440 * i) / AR), 1);
  const s = stats(mono(sine));
  assert.ok(s.hasSound && Math.abs(s.peakDb - -4.3) < 0.2, `peak ${s.peakDb}`);
  assert.equal(stats(mono(Buffer.alloc(AR * 4))).hasSound, false);
  assert.equal(similarity(mono(sine), mono(sine)), 1);
  const shifted = stereo((i) => Math.sin((2 * Math.PI * 440 * (i + 200)) / AR), 1);
  assert.ok(similarity(mono(sine), mono(shifted)) > 0.99, "a few ms of shift still matches");
  assert.equal(toWav(sine).toString("ascii", 0, 4), "RIFF");
});

test("audio: stale blocks (a missed refill plays the old block again)", () => {
  const block = 256, x = stereo((i) => Math.sin((2 * Math.PI * 333.3 * i) / AR) * (0.5 + 0.5 * Math.sin(i / 997)), 0.5);
  const stale = Buffer.from(x);
  for (let k = 4; k * block * 2 < stale.length / 4 - block; k += 6) stale.copy(stale, (k * block) * 4, (k * block - 2 * block) * 4, (k * block - block) * 4);
  const clean = Math.max(...repeats(x).values()), bad = repeats(stale);
  assert.ok(clean < 0.01, `clean audio: ${clean}`);
  assert.ok(bad.get(2 * block) > 0.05, `stale blocks found at lag ${2 * block}: ${bad.get(2 * block)}`);
});

// ---- images
test("images: PPM in, PNG out, differences", () => {
  const ppm = (fill) => { const h = Buffer.from("P6 4 4 255\n"), d = Buffer.alloc(48, 0); fill(d); return Buffer.concat([h, d]); };
  const a = readPpm(ppm(() => {})), b = readPpm(ppm((d) => { d[0] = 255; d[1] = 255; d[2] = 255; }));
  assert.equal(a.w, 4); assert.equal(diffShare(a, a), 0); assert.equal(diffShare(a, b), 1 / 16);
  assert.equal(hasContent(a), false); assert.equal(hasContent(b), true);
  assert.equal(png(a, 2).subarray(1, 4).toString(), "PNG");
});

// ---- sizes, packages, profiles
test("sizes: one line, with what changed", () => {
  const cur = { appBytes: 141324, appSlot: 581564, sizes: { ram: 40248, pool: 69384, ramtext: 4964 } };
  assert.equal(describeSizes(cur), "app 141,324 B of 581,564 (24%) · RAM 40,248 · pool 69,384 · RAM code 4,964");
  assert.match(describeSizes(cur, { appBytes: 139276, sizes: { ram: 40248, pool: 69384, ramtext: 4964 } }), /\(\+2,048\).*changes since the last build/);
  assert.doesNotMatch(describeSizes(cur, cur), /changes/);
});

test("package check: not a package", () => {
  const d = mkdtempSync(join(tmpdir(), "fm1-lab-test-")), f = join(d, "junk.fwsc");
  writeFileSync(f, Buffer.alloc(5000, 7));
  const c = checkPackage(f);
  assert.equal(c.ok, false); assert.match(describe(c), /NOT A VALID PACKAGE/);
  rmSync(d, { recursive: true });
});

test("profile: samples into regions, wait loops marked", () => {
  const tp = parseTprof("0 0x02000100 50\n0 0x02000104 50\n0 0x02009000 10\n1 0x01c00b98 990\n1 0x02000100 10\nm0 0x02000100 3\n");
  assert.equal(tp.pcs[0].length, 3); assert.equal(tp.misses[0].n, 3);
  const c0 = hotspots(tp.pcs[0]), c1 = hotspots(tp.pcs[1]);
  assert.equal(c0.regions[0].share, 0.9091); assert.equal(c0.regions[0].area, "flash");
  assert.equal(c1.regions[0].likelyWait, true); assert.equal(c1.regions[0].area, "RAM"); assert.equal(c1.busyShare, 0.01);
});

test("scenario files: YAML and fm1-base .txt scripts load", () => {
  const d = mkdtempSync(join(tmpdir(), "fm1-lab-test-"));
  writeFileSync(join(d, "a.yaml"), "name: a\nsteps:\n  - { at: 100, note: C4 }\n");
  writeFileSync(join(d, "b.txt"), "wait 100\ntapkey 3\nsaid X\n");
  assert.equal(loadScenario(join(d, "a.yaml")).name, "a");
  const b = loadScenario(join(d, "b.txt"));
  assert.equal(b.kind, "fm1-base test script"); assert.equal(b.timed.length, 1); assert.equal(b.steps[0].key, "n3");
  rmSync(d, { recursive: true });
});

test("gif: an animation, unchanged frames merged, changed rectangles only", () => {
  const frame = (x) => { const rgb = Buffer.alloc(16 * 16 * 3, 20); if (x != null) for (let y = 4; y < 8; y++) rgb.fill(250, (y * 16 + x) * 3, (y * 16 + x + 2) * 3); return { w: 16, h: 16, rgb }; };
  const g = gif([frame(null), frame(null), frame(3), frame(3), frame(9)], { delayMs: 100 });
  assert.equal(g.subarray(0, 6).toString(), "GIF89a"); assert.equal(g[g.length - 1], 0x3b);
  assert.equal(g.readUInt16LE(6), 16); assert.equal(g.readUInt16LE(8), 16);
  // image descriptors (0x2c after a graphic control extension 21 f9 04): three distinct frames
  let n = 0, delays = [];
  for (let i = 0; i + 8 < g.length; i++) if (g[i] === 0x21 && g[i + 1] === 0xf9 && g[i + 2] === 4) { n++; delays.push(g.readUInt16LE(i + 4)); }
  assert.equal(n, 3, "5 frames, 3 different"); assert.deepEqual(delays, [20, 20, 10], "repeats lengthen the frame before");
  assert.ok(g.includes(Buffer.from("NETSCAPE2.0")), "loops");
  assert.equal(gif([]), null);
});

// scenario.mjs — fm1-lab scenario files (YAML or JSON): what to play into a firmware and what to expect.
//
//   name: x0x smoke test
//   ms: 6000                    # how long to run (default: last step + 1500)
//   flash: puya                 # puya (original) | uc25 (UC25HQ80) | a 6-digit JEDEC id
//   strict: false               # cycle-accurate timing as on the real chip (slower)
//   click_ms: 250               # turn encoders one click at a time, this far apart (for compare; see below)
//   reader: true                # a screen reader on USB (fm1-base's protocol): what the firmware says, and each
//                               # screenshot's text (on by itself with said/unsaid)
//   usb: true                   # a USB cable to the computer (on by itself with reader, usb_midi, midi_out checks)
//   steps:
//     - { at: 1200, press: PLAY }               # a button (OCTDN OCTUP FX SCL ENV LFO EDIT GLO HOME SAVE ARP SEQ PLAY REC)
//     - { at: 1500, note: C4, vel: 100, hold: 400 }   # a key by note (F3..G5) or n0..n26
//     - { at: 2000, turn: KNOB1, clicks: 3 }    # an encoder: SELECT ALGORITHM KNOB1-4 PRESETS (or 0-6); clicks +/-
//     - { at: 2200, pot: 700 }                  # the MASTER pot, 0..1023
//     - { at: 2500, midi: "90 3c 64" }          # bytes into the TRS MIDI IN jack
//     - { at: 2600, usb_midi: "90 3c 64" }      # a MIDI message from the computer over USB
//     - { at: 3000, screenshot: playing }       # a named LCD screenshot
//   expect:
//     boots: true               # the screen shows something
//     sound: true               # audible output after the first step (or `sound: false`: silence)
//     peak_db_min: -30          # loudest sample at least this loud (dBFS)
//     no_clipping: true
//     flash_writes_min: 1       # it saved something
//     screen_changes: true      # the last screenshot differs from the first
//     said: "OCTAVE +1"         # the screen reader heard this (or a list); unsaid: never heard
//     midi_out_min: 2           # the firmware sent at least this many MIDI messages over USB
//     midi_out: "90 3c"         # ... and one starting with these bytes (or a list)
import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import * as yaml from "./vendor/js-yaml.mjs";
import { FLASH } from "./emu.mjs";
import { translate } from "./hostscript.mjs";

const BUTTONS = ["OCTDN", "OCTUP", "FX", "SCL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"];
const ALIASES = { "OCT-": "OCTDN", "OCT+": "OCTUP", OCTDOWN: "OCTDN" };
const ENCODERS = { SELECT: 0, ALGORITHM: 1, KNOB1: 2, KNOB2: 3, KNOB3: 4, KNOB4: 5, PRESETS: 6 };
const NOTE = /^[A-G](#|B)?[0-9]$/i;

export function loadScenario(path) {
  const text = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".txt") {        // an fm1-base host-simulator test script
    const t = translate(text, basename(path, ".txt"));
    return { ...normalize(t.raw, path), timed: t.timed, skipped: t.skipped, kind: "fm1-base test script" };
  }
  const raw = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : yaml.load(text);
  return normalize(raw, path);
}

export function normalize(raw, source = "(inline)") {
  if (!raw || typeof raw !== "object") throw new Error(`${source}: not a scenario`);
  const err = (m) => { throw new Error(`${source}: ${m}`); };
  const steps = (raw.steps || []).map((s, i) => {
    const at = Number(s.at ?? 0);
    if (!Number.isFinite(at) || at < 0) err(`step ${i + 1}: "at" must be a time in ms`);
    if (s.press != null) {
      const b = String(s.press).toUpperCase(), name = ALIASES[b] || b;
      if (!BUTTONS.includes(name)) err(`step ${i + 1}: unknown button "${s.press}" (one of ${BUTTONS.join(" ")})`);
      return { at, kind: "press", key: name, hold: Number(s.hold ?? 100) };
    }
    if (s.note != null) {
      const k = String(s.note).toUpperCase();
      if (!NOTE.test(k) && !/^N([0-9]|1[0-9]|2[0-6])$/.test(k)) err(`step ${i + 1}: unknown note "${s.note}" (F3..G5, or n0..n26)`);
      if (NOTE.test(k)) {   // the FM-1's 27 keys: F3 (MIDI 53) .. G5 (79) at the default octave
        const pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[k[0]] + (k[1] === "#" ? 1 : k[1] === "B" ? -1 : 0);
        const midi = 12 * (Number(k[k.length - 1]) + 1) + pc;
        if (midi < 53 || midi > 79) err(`step ${i + 1}: note "${s.note}" is off the FM-1's keyboard (F3..G5)`);
      }
      const vel = s.vel == null ? null : Math.max(1, Math.min(127, Number(s.vel)));
      return { at, kind: "note", key: k.replace(/^N/, "n"), vel, hold: Number(s.hold ?? 300) };
    }
    if (s.turn != null) {
      const e = typeof s.turn === "number" ? s.turn : ENCODERS[String(s.turn).toUpperCase()];
      if (!(e >= 0 && e <= 6)) err(`step ${i + 1}: unknown encoder "${s.turn}" (${Object.keys(ENCODERS).join(" ")} or 0-6)`);
      const clicks = Math.trunc(Number(s.clicks ?? 1)); if (!clicks) err(`step ${i + 1}: "clicks" must be non-zero`);
      return { at, kind: "turn", enc: e, clicks };
    }
    if (s.pot != null) return { at, kind: "pot", value: Math.max(0, Math.min(1023, Math.round(Number(s.pot)))) };
    if (s.midi != null) {
      const hex = String(s.midi).replace(/[^0-9a-f]/gi, "");
      if (!hex || hex.length % 2) err(`step ${i + 1}: "midi" must be hex bytes, e.g. "90 3c 64"`);
      return { at, kind: "midi", hex: hex.toLowerCase() };
    }
    if (s.usb_midi != null) {
      const hex = String(s.usb_midi).replace(/[^0-9a-f]/gi, "");
      if (!hex || hex.length % 2) err(`step ${i + 1}: "usb_midi" must be hex bytes, e.g. "90 3c 64"`);
      return { at, kind: "usb_midi", hex: hex.toLowerCase() };
    }
    if (s.screenshot != null) return { at, kind: "screenshot", name: String(s.screenshot).replace(/[^\w.-]+/g, "-") || `t${at}` };
    err(`step ${i + 1}: needs one of press, note, turn, pot, midi, usb_midi, screenshot`);
  }).flatMap((s) => {
    // click_ms: a multi-click turn as single clicks that far apart, at a hand's pace. A burst of clicks in one instant
    // is split between the firmware's polls by its code timing, so two builds of one firmware can end a fast turn on
    // different values (an accelerating encoder); spread-out clicks don't.
    if (s.kind !== "turn" || !raw.click_ms || Math.abs(s.clicks) < 2) return [s];
    const one = Math.sign(s.clicks);
    return Array.from({ length: Math.abs(s.clicks) }, (_, i) => ({ ...s, at: s.at + i * Number(raw.click_ms), clicks: one }));
  }).sort((a, b) => a.at - b.at);
  const lastEnd = steps.reduce((m, s) => Math.max(m, s.at + (s.hold || 0)), 0);
  const ms = Number(raw.ms ?? Math.max(3000, lastEnd + 1500));
  if (lastEnd > ms) err(`steps run past "ms" (${lastEnd} > ${ms})`);
  const flash = raw.flash == null ? FLASH.puya : (FLASH[String(raw.flash).toLowerCase()] || String(raw.flash).toLowerCase());
  if (!/^[0-9a-f]{6}$/.test(flash)) err(`"flash" must be puya, uc25 or a 6-digit JEDEC id`);
  const ex = raw.expect || {};
  const reader = !!(raw.reader || ex.said != null || ex.unsaid != null);
  const usb = !!(raw.usb || reader || ex.midi_out != null || ex.midi_out_min != null || steps.some((s) => s.kind === "usb_midi"));
  const readerFrom = raw.reader_from != null ? Number(raw.reader_from) : 1000;
  return { name: raw.name || basename(source).replace(/\.(ya?ml|json)$/i, ""), source, ms, flash, strict: !!raw.strict, usb, reader, readerFrom,
           mhz: Number(raw.mhz ?? 240), clickMs: raw.click_ms ? Number(raw.click_ms) : null, steps, expect: raw.expect || {} };
}

/** The steps as fm1-live's FM1_BENCH_KEYS script. */
export function toKeys(sc) {
  const ev = [];
  for (const s of sc.steps) {
    if (s.kind === "press") ev.push([s.at, s.key], [s.at + s.hold, s.key + "^"]);
    else if (s.kind === "note") ev.push([s.at, s.key + (s.vel ? `@${s.vel}` : "")], [s.at + s.hold, s.key + "^"]);
    else if (s.kind === "turn") ev.push([s.at, `e${s.enc}:${s.clicks > 0 ? "+" : ""}${s.clicks}`]);
    else if (s.kind === "pot") ev.push([s.at, `pot:${s.value}`]);
    else if (s.kind === "midi") ev.push([s.at, `m${s.hex}`]);
  }
  return ev.sort((a, b) => a[0] - b[0]).map(([t, k]) => `${Math.round(t)}:${k}`).join(",");
}

/** A default smoke scenario for any firmware (used by sweep and when no scenario is given). */
export const SMOKE = normalize({
  name: "smoke", ms: 5000,
  steps: [{ at: 1500, screenshot: "boot" }, { at: 2000, note: "C4", vel: 100, hold: 600 }, { at: 2600, screenshot: "note" },
          { at: 3000, press: "PLAY" }, { at: 4800, screenshot: "play" }],
  expect: { boots: true },
}, "(built-in smoke)");

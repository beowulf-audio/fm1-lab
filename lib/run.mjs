// run.mjs — play a scenario into a firmware headless and measure what came out.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { exec, FRAME_MS } from "./emu.mjs";
import { toKeys } from "./scenario.mjs";
import { chipWith, resourcesId } from "./resources.mjs";
import { evaluate } from "./hostscript.mjs";
import { elfFor, readCrash, describeCrash } from "./crash.mjs";
import { readPpm, png, hasContent, diffShare } from "./image.mjs";
import { toWav, mono, stats, envelope, bands } from "./audio.mjs";

/**
 * @param {string} fwsc
 * @param {object} sc   a normalized scenario
 * @param {{out?:string, sandbox?:boolean, strict?:boolean, mhz?:number, tprof?:[number,number], jedec?:string, flashFile?:string,
 *          resources?:{file:string, base:number}}} o  resources: the firmware's resource region, in place (lib/resources.mjs)
 */
export async function runScenario(fwsc, sc, o = {}) {
  // USB: MIDI the scenario sends, and with a screen reader its HELLO every 2 s (it stops talking to a reader not heard
  // from in 5 s) and a WHERE just before each screenshot (the whole screen said, for the screenshot's text)
  const usbSend = sc.steps.filter((s) => s.kind === "usb_midi").map((s) => [s.at, s.hex]);
  if (sc.reader) {
    const from = sc.readerFrom ?? 1000;
    for (let t = from; t < sc.ms; t += 2000) usbSend.push([t, "f07d53520101f7"]);
    for (const s of sc.steps) if (s.kind === "screenshot" && s.at > from + 100) usbSend.push([s.at - 120, "f07d535203f7"]);
  }
  if (o.resources && o.flashFile) throw new Error("resources and a flash image: one or the other");
  const flashFile = o.resources ? await chipWith(fwsc, o.resources, { jedec: o.jedec || sc.flash, sandbox: o.sandbox }) : o.flashFile;
  const r = await exec(fwsc, { ms: sc.ms, keys: toKeys(sc), jedec: o.jedec || sc.flash, strict: o.strict ?? sc.strict,
                               mhz: o.mhz ?? sc.mhz, record: true, tprof: o.tprof, flashFile, sandbox: o.sandbox,
                               usb: sc.usb, usbSend: usbSend.sort((a, b) => a[0] - b[0]), dumpRam: !!(o.elf ?? elfFor(fwsc)) });
  const elf = o.elf ?? elfFor(fwsc);
  const crash = elf ? readCrash(r.ram, elf) : null;
  const usb = sc.usb ? parseUsb(r.log) : null;
  const frames = r.frames || [];
  const frameAt = (ms) => frames[Math.min(frames.length - 1, Math.max(0, Math.round(ms / FRAME_MS)))];
  const shots = sc.steps.filter((s) => s.kind === "screenshot").map((s) => ({ name: s.name, at: s.at, img: readPpm(frameAt(s.at)),
    said: usb?.said.filter((x) => x.ms >= s.at - 120 && x.ms <= s.at + 200).map((x) => x.text).join(" ") || null }));
  const last = readPpm(r.lcd) || readPpm(frames[frames.length - 1]);
  shots.push({ name: "end", at: sc.ms, img: last });

  // audio: whole run, and from the first input on (boot noise excluded)
  const firstInput = sc.steps.find((s) => s.kind !== "screenshot")?.at ?? 0;
  const all = mono(r.audio), after = mono(r.audio, firstInput);
  const audio = { all: stats(all), afterFirstInput: stats(after), envelope: envelope(all, 50), bands: bands(after.length > 4096 ? after : all) };

  // the screen over time: distinct frames, and when it first showed something
  const hashes = new Set(); let firstContentMs = null;
  frames.forEach((f, i) => { hashes.add(createHash("sha1").update(f).digest("hex")); if (firstContentMs === null && hasContent(readPpm(f))) firstContentMs = i * FRAME_MS; });
  const screen = { frames: frames.length, distinctFrames: hashes.size, firstContentMs, booted: firstContentMs !== null || hasContent(last) };

  const result = {
    tool: "fm1-lab run", firmware: basename(fwsc), scenario: sc.name, ms: sc.ms, flash: o.jedec || sc.flash, strict: !!(o.strict ?? sc.strict), mhz: o.mhz ?? sc.mhz,
    resources: o.resources ? resourcesId(o.resources) : null,
    exitCode: r.code, fault: r.fault, wallMs: r.wallMs, speed: +(sc.ms / Math.max(1, r.wallMs)).toFixed(2),
    screen, audio, flashOps: r.flash, leds: r.leds, isrShare: r.isrShare,
    usb: usb ? { configured: usb.configured, reader: usb.reader, said: usb.said, midiOut: usb.midiOut } : null,
    crash: crash ? { ...crash, text: describeCrash(crash) } : null, crashChecked: !!elf,
    screenshots: shots.map((s) => ({ name: s.name, at: s.at, file: s.img ? `${s.name}.png` : null, said: s.said })),
    checks: [],
  };
  result.checks = checkExpect(sc.expect, result, shots);
  if (sc.timed?.length) { result._raw = { audio: r.audio }; result.checks.push(...evaluate(sc.timed, result)); }
  if (sc.skipped?.length) result.simulatorOnly = sc.skipped;
  result.pass = result.exitCode === 0 && result.checks.every((c) => c.ok);

  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    for (const s of shots) if (s.img) writeFileSync(join(o.out, `${s.name}.png`), png(s.img, 2));
    if (r.audio) writeFileSync(join(o.out, "audio.wav"), toWav(r.audio));
    writeFileSync(join(o.out, "run.json"), JSON.stringify(result, null, 2));
  }
  result._raw = { audio: r.audio, shots, tprof: r.tprof, log: r.log, frames };
  return result;
}

function checkExpect(ex, r, shots) {
  const c = [];
  const add = (name, ok, detail) => c.push({ name, ok: !!ok, detail });
  if (ex.boots != null) add("boots", r.screen.booted === !!ex.boots, r.screen.booted ? `screen showed content at ${r.screen.firstContentMs} ms` : "the screen stayed blank");
  if (ex.sound != null) add("sound", r.audio.afterFirstInput.hasSound === !!ex.sound, `peak ${r.audio.afterFirstInput.peakDb} dBFS after the first input`);
  if (ex.peak_db_min != null) add("peak_db_min", r.audio.afterFirstInput.peakDb >= ex.peak_db_min, `peak ${r.audio.afterFirstInput.peakDb} dBFS (min ${ex.peak_db_min})`);
  if (ex.no_clipping) add("no_clipping", r.audio.all.clippedSamples === 0, `${r.audio.all.clippedSamples} clipped samples`);
  if (ex.flash_writes_min != null) add("flash_writes_min", r.flashOps.writes >= ex.flash_writes_min, `${r.flashOps.writes} flash writes (min ${ex.flash_writes_min})`);
  if (ex.screen_changes != null) {
    const a = shots[0]?.img, b = shots[shots.length - 1]?.img, d = a && b ? diffShare(a, b) : 0;
    add("screen_changes", (d > 0.002) === !!ex.screen_changes, `${(d * 100).toFixed(1)}% of pixels changed between "${shots[0]?.name}" and "end"`);
  }
  const list = (v) => (Array.isArray(v) ? v : [v]).map(String);
  if (ex.said != null || ex.unsaid != null) {
    const heard = r.usb?.said.map((x) => x.text) || [];
    if (!r.usb?.reader) add("reader", false, "the firmware never answered the screen reader's HELLO (fm1-base's announce protocol over USB)");
    for (const t of ex.said != null ? list(ex.said) : []) add(`said "${t}"`, heard.some((h) => h.includes(t)), heard.find((h) => h.includes(t)) || `not heard (${heard.length} things said)`);
    for (const t of ex.unsaid != null ? list(ex.unsaid) : []) add(`unsaid "${t}"`, !heard.some((h) => h.includes(t)), heard.find((h) => h.includes(t)) || "not heard");
  }
  if (ex.midi_out_min != null) add("midi_out_min", (r.usb?.midiOut.length || 0) >= ex.midi_out_min, `${r.usb?.midiOut.length || 0} MIDI messages out over USB (min ${ex.midi_out_min})`);
  if (ex.midi_out != null) for (const p of list(ex.midi_out)) {
    const want = p.replace(/[^0-9a-f]/gi, "").toLowerCase(), hit = r.usb?.midiOut.find((m) => m.hex.replace(/ /g, "").startsWith(want));
    add(`midi_out ${p}`, !!hit, hit ? `${hit.hex} at ${hit.ms} ms` : "not sent");
  }
  if (ex.no_fault !== false) add("no_fault", !r.fault, r.fault || "no CPU fault");
  if (r.crashChecked && ex.no_crash !== false) add("no_crash", !r.crash, r.crash ? r.crash.text : "the firmware's fault handler recorded no crash");
  return c;
}

/** The emulated computer's side of the USB cable: the firmware's MIDI out, and fm1-base's screen-reader messages. */
export function parseUsb(log) {
  const out = { configured: null, reader: null, said: [], midiOut: [] };
  for (const l of log.split("\n")) {
    const c = l.match(/usb: Configured \{ product: "([^"]*)"/); if (c) out.configured = c[1];
    const m = l.match(/^\[\s*(\d+) ms\] usb in:\s+(.*)$/); if (!m) continue;
    const ms = +m[1], b = m[2].trim().split(/\s+/).map((h) => parseInt(h, 16));
    if (b[0] === 0xf0 && b[1] === 0x7d && b[2] === 0x53 && b[3] === 0x52) {        // F0 7D 53 52: the screen reader's
      const body = b.slice(5, b[b.length - 1] === 0xf7 ? -1 : undefined);
      if (b[4] === 1) { const z = body.indexOf(0); out.reader = { name: String.fromCharCode(...body.slice(1, z < 0 ? undefined : z)), words: z < 0 ? null : String.fromCharCode(...body.slice(z + 1)) }; }
      else if (b[4] === 16) out.said.push({ ms, flags: body[0], text: String.fromCharCode(...body.slice(1)) });
    } else out.midiOut.push({ ms, hex: m[2].trim() });
  }
  return out;
}

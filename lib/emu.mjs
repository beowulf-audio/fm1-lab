// emu.mjs — run a firmware in fm1-emu's fm1-live headless and collect what it did.
// The emulator always runs sandboxed (lib/sandbox.mjs: no network, no reading HOME, writes only to its run directory) unless disabled
// (on Linux, e.g. in CI, it runs as is: use an isolated runner).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, copyFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { wrap } from "./sandbox.mjs";
import { join, dirname, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
export const ROOT = resolve(here, "..");
export const FLASH = { puya: "856014", uc25: "b36014" };
export const FRAME_MS = 16;          // --record writes an LCD frame every 16 ms
export const AUDIO_RATE = 44118;     // --record audio.raw: stereo s16le at the FM-1's rate
export const XIP_BASE = 0x0200_0000;  // flash, executed in place (fm1-soc lib.rs)
export const RAM_BASE = 0x01c0_0000;  // on-chip RAM

export function emulatorPath() {
  const p = process.env.FM1_LAB_EMU || join(ROOT, ".work", "target", "release", "fm1-live");
  if (!existsSync(p)) throw new Error(`fm1-live not found at ${p}: run tools/setup-emu.sh first (or set FM1_LAB_EMU)`);
  return p;
}
export { sandboxAvailable } from "./sandbox.mjs";

/**
 * Run fm1-live headless once.
 * @param {string} fwsc
 * @param {{ms:number, keys?:string, jedec?:string, flashFile?:string, cut?:number, strict?:boolean, mhz?:number,
 *          record?:boolean, tprof?:[number,number], sandbox?:boolean, env?:object}} o
 * @returns {Promise<{code:number, log:string, wallMs:number, flash:object, leds:number[], audioPeak:number|null, isrShare:number|null,
 *          frames:Buffer[]|null, audio:Buffer|null, lcd:Buffer|null, panel:Buffer|null, tprof:string|null}>}
 */
export function exec(fwsc, o) {
  const dir = mkdtempSync(join(tmpdir(), "fm1-lab-"));
  mkdirSync(join(dir, "work"));
  // the firmware (and a flash image) are copied into the run's own directory: the sandbox reads nothing else of HOME
  copyFileSync(resolve(fwsc), join(dir, "fw.fwsc"));
  const args = ["--fwsc", join(dir, "fw.fwsc"), "--shot", String(o.ms), "--midi", "none"];
  if (o.mhz && o.mhz !== 240) args.push("--mhz", String(o.mhz));
  if (o.flashFile) copyFileSync(resolve(o.flashFile), join(dir, "flash.bin"));
  // the chip is saved to flash.bin at the end: o.flashOut returns it (without o.flashFile, as the package leaves it)
  if (o.flashFile || o.flashOut) args.push("--flash", join(dir, "flash.bin"));
  if (o.record) args.push("--record", "rec", "--lcd-only");
  if (o.usb || o.usbPlay) args.push("--usb");          // a USB cable to an emulated computer; o.usbSend: [[ms, hex]...]
  // o.usbPlay: a WAV the computer plays to the firmware's USB audio output (patch 0002), copied in (the sandbox reads
  // only the run's directory)
  if (o.usbPlay) copyFileSync(resolve(o.usbPlay), join(dir, "usb_play.wav"));
  const env = { ...process.env, FM1_FLASH_TRACE: "1", ...(o.env || {}) };
  if (o.jedec) env.FM1_FLASH_JEDEC = o.jedec;
  if (o.keys) env.FM1_BENCH_KEYS = o.keys;
  if (o.usbPlay) env.FM1_USB_PLAY = join(dir, "usb_play.wav");
  if (o.usb && o.usbSend?.length) { writeFileSync(join(dir, "usb_send.txt"), o.usbSend.map(([t, h]) => `${Math.round(t)}:${h}`).join(";")); env.FM1_USB_SEND = `@${join(dir, "usb_send.txt")}`; }
  if (o.cut != null) env.FM1_FLASH_CUT = String(o.cut);
  if (o.strict) env.FM1_STRICT = "1";
  if (o.tprof) env.FM1_TPROF = `${join(dir, "tprof.txt")},${o.tprof[0]},${o.tprof[1]}`;
  if (o.dumpRam) env.FM1_DUMPRAM = join(dir, "ram.bin");   // the RAM at the end (crash records: lib/crash.mjs)
  const w = o.sandbox === false ? { cmd: emulatorPath(), args } : wrap(dir, [], emulatorPath(), args);
  const cmd = w.cmd, argv = w.args;
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
    p.on("error", (e) => { rmSync(dir, { recursive: true, force: true }); rej(e); });
    p.on("close", (code) => {
      const r = { code, log, wallMs: Date.now() - t0, ...parseLog(log) };
      const f = (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n)) : null);
      r.panel = f("work/panel.ppm"); r.lcd = f("work/lcd.ppm");
      r.audio = f("rec/audio.raw");
      r.frames = existsSync(join(dir, "rec")) ? readdirSync(join(dir, "rec")).filter((n) => n.endsWith(".ppm")).sort().map((n) => readFileSync(join(dir, "rec", n))) : null;
      r.tprof = o.tprof && existsSync(join(dir, "tprof.txt")) ? readFileSync(join(dir, "tprof.txt"), "utf8") : null;
      r.ram = o.dumpRam ? f("ram.bin") : null;
      r.flashImage = o.flashOut ? f("flash.bin") : null;
      rmSync(dir, { recursive: true, force: true });
      res(r);
    });
  });
}

/** Back-compatible: one headless boot (used by brick-test). */
export const boot = (fwsc, o = {}) => exec(fwsc, { ms: o.ms ?? 4000, ...o });

export function parseLog(log) {
  const byCmd = {};
  for (const m of log.matchAll(/^flash cmd ([0-9a-f]{2}) addr ([0-9a-f]{6})/gm)) byCmd[m[1]] = (byCmd[m[1]] || 0) + 1;
  const n = (...c) => c.reduce((s, k) => s + (byCmd[k] || 0), 0);
  const flash = { probes: n("9f"), reads: n("03", "0b"), programs: n("02"), erases: n("20", "d8", "52", "60", "c7"), byCmd };
  flash.writes = flash.programs + flash.erases;
  const leds = (log.match(/LEDs lit: \[([^\]]*)\]/)?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const ap = log.match(/audio peak over the last [0-9.]+ s: (\d+)/);
  const isr = log.match(/(\d+)% of instructions in ISRs/);
  const fault = log.match(/^(halted|fault|panic|error)[^\n]*/im)?.[0] || null;
  // patch 0002: how the computer's playing to the USB audio output went
  const up = log.match(/^usb play: (\d+) ch x (\d+) B at (\d+) Hz, (\d+) packets \((\d+) lost[^)]*\), (\d+) frames of silence/m);
  const usbPlay = up ? { channels: +up[1], bytes: +up[2], rate: +up[3], packets: +up[4], lost: +up[5], silentFrames: +up[6] }
    : /^usb play: the device has no USB audio output/m.test(log) ? { none: true } : /^usb play: .* never started/m.test(log) ? { started: false } : null;
  return { flash, usbPlay, leds, audioPeak: ap ? Number(ap[1]) : null, isrShare: isr ? Number(isr[1]) / 100 : null, fault };
}

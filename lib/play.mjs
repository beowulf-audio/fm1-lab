// play.mjs — play a firmware in the emulator's window (fm1-live), with audio coming in over USB if asked for.
//
//   fm1-lab play [DIR | FILE.fwsc] [IN.wav | --mic | --audio-in NAME] [--midi NAME|none] [--fresh]
//
// DIR: an fm1-lab project (fm1lab.json's package; default the current directory). The audio, into the firmware's USB
// audio output as a computer playing through it would (patch 0002): a WAV, looped; this computer's microphone; or any
// input whose name has NAME (a loopback such as BlackHole plays any app into it). The flash is kept between plays in
// .work/play/<package>.flash (what the firmware saves), unless --fresh.
//
// The window runs fm1-live itself, not in fm1-lab's sandbox: it needs the screen, the audio devices and MIDI. The
// firmware runs inside the emulator, which has no file or network access to give it.
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { emulatorPath, ROOT } from "./emu.mjs";

/** The package a DIR or FILE names: {fwsc, name}, or throws */
export function packageOf(target = ".") {
  const t = resolve(target);
  if (existsSync(t) && statSync(t).isFile()) {
    if (extname(t).toLowerCase() !== ".fwsc") throw new Error(`${target}: not a .fwsc package`);
    return { fwsc: t, name: basename(t, extname(t)) };
  }
  const lab = join(t, "fm1lab.json");
  if (!existsSync(lab)) throw new Error(`${target}: no fm1lab.json (an fm1-lab project) and not a .fwsc`);
  const pkg = JSON.parse(readFileSync(lab, "utf8")).package;
  if (!pkg) throw new Error(`${lab}: no "package"`);
  const fwsc = join(t, pkg);
  if (!existsSync(fwsc)) throw new Error(`${pkg} isn't built yet: fm1-lab build ${target}`);
  return { fwsc, name: basename(fwsc, ".fwsc") };
}

/** fm1-live's arguments and environment for a play: {cmd, args, env, say} */
export function playCommand(o) {
  const { fwsc, name } = packageOf(o.target);
  const args = ["--fwsc", fwsc, "--usb"], env = { ...process.env }, say = [];
  if (!o.fresh) {
    const key = createHash("sha256").update(fwsc).digest("hex").slice(0, 8);
    const dir = join(ROOT, ".work", "play");
    mkdirSync(dir, { recursive: true });
    args.push("--flash", join(dir, `${name}-${key}.flash`));
  }
  if (o.midi) args.push("--midi", o.midi);
  const inputs = [o.wav, o.mic, o.audioIn].filter(Boolean).length;
  if (inputs > 1) throw new Error("one audio input: a WAV, --mic or --audio-in");
  if (o.wav) {
    const w = resolve(o.wav);
    if (!existsSync(w)) throw new Error(`${o.wav}: no such file`);
    env.FM1_USB_PLAY = w;
    say.push(`audio in: ${basename(w)}, looped, over USB`);
  } else if (o.mic) {
    args.push("--audio-in", "default");
    say.push("audio in: this computer's microphone, over USB (macOS asks once for the terminal's microphone permission)");
  } else if (o.audioIn) {
    args.push("--audio-in", o.audioIn);
    say.push(`audio in: the input "${o.audioIn}", over USB`);
  }
  return { cmd: emulatorPath(), args, env, say, name };
}

/** Run it: the window, until it is closed. Resolves to fm1-live's exit code. */
export function playFirmware(o) {
  const c = playCommand(o);
  return new Promise((res, rej) => {
    const p = spawn(c.cmd, c.args, { env: c.env, stdio: "inherit" });
    p.on("error", rej);
    p.on("close", (code) => res(code ?? 1));
  });
}

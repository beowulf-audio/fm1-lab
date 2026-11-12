// audiofile.mjs — any audio file as the WAV the emulator plays into a firmware's USB audio (patch 0002 reads WAV:
// PCM 16 or 24 bits, any rate). MP3, FLAC, M4A / AAC, AIFF, CAF, OGG... are converted once to 16-bit stereo 44.1 kHz
// and kept in .work/audio/ (by the file's path, size and time): macOS's own afconvert, else ffmpeg.
import { existsSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ROOT } from "./emu.mjs";

export const AUDIO_EXT = /\.(wav|wave|mp3|flac|m4a|aac|mp4|aif|aiff|caf|ogg|opus)$/i;

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;

/** A WAV of `file` the emulator can play: the file itself if it is a WAV, else a converted copy (cached). */
export function audioToWav(file) {
  const f = resolve(file);
  if (!existsSync(f)) throw new Error(`${file}: no such file`);
  if (/\.(wav|wave)$/i.test(f)) return f;
  if (!AUDIO_EXT.test(f)) throw new Error(`${file}: not an audio file fm1-lab knows (${AUDIO_EXT.source.replace(/[\\$()]/g, "").replace(/\|/g, ", ").slice(2)})`);
  const st = statSync(f);
  const key = createHash("sha256").update(`${f}\n${st.size}\n${st.mtimeMs}`).digest("hex").slice(0, 16);
  const dir = join(ROOT, ".work", "audio");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${basename(f, extname(f)).replace(/[^\w.-]+/g, "_").slice(0, 40)}-${key}.wav`);
  if (existsSync(out)) return out;
  let r;
  if (process.platform === "darwin" && has("afconvert"))
    r = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@44100", "-c", "2", f, out], { encoding: "utf8" });
  else if (has("ffmpeg"))
    r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", f, "-ac", "2", "-ar", "44100", "-sample_fmt", "s16", out], { encoding: "utf8" });
  else throw new Error(`${file}: to play it, convert it to a WAV (no afconvert or ffmpeg here)`);
  if (r.status !== 0 || !existsSync(out)) throw new Error(`${file}: couldn't convert it to a WAV: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  return out;
}

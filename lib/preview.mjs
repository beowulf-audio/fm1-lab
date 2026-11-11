// preview.mjs — a firmware's preview from one run of a tour: its screen as an animated GIF, its sound as a short AAC
// file (.m4a, plays in every browser). The tour is a scenario (scenarios/preview.yaml, or one written for the firmware);
// the preview records which tour made it (its source and SHA-256), so it can be made again when the tour changes.
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { gif } from "./gif.mjs";
import { readPpm } from "./image.mjs";
import { toWav } from "./audio.mjs";
import { FRAME_MS, AUDIO_RATE } from "./emu.mjs";
import { wrap } from "./sandbox.mjs";

let ffmpegPath;
export function ffmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try { ffmpegPath = execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim() || null; } catch { ffmpegPath = null; }
  return ffmpegPath;
}

export const tourHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Where the tour starts showing something (its first step, a little before), and where it ends. */
function span(sc) {
  const first = sc.steps.find((s) => s.kind !== "screenshot")?.at ?? 1500;
  return [Math.max(0, first - 300), sc.ms];
}

/** An animated GIF of the run's screen, a frame every `stepMs`. */
export function previewGif(run, sc, stepMs = 100) {
  const [a, b] = span(sc), pick = [];
  for (let ms = a; ms < b; ms += stepMs) { const f = run._raw.frames?.[Math.round(ms / FRAME_MS)]; if (f) pick.push(readPpm(f)); }
  return gif(pick, { delayMs: stepMs });
}

/** The run's sound over the tour as AAC (.m4a, 64 kb/s stereo), through ffmpeg in the sandbox; null without ffmpeg. */
export function previewAudio(run, sc, outPath) {
  const ff = ffmpeg(); if (!ff || !run._raw.audio) return null;
  const [a, b] = span(sc), bpf = 4;
  const from = Math.floor((a / 1000) * AUDIO_RATE) * bpf, to = Math.min(run._raw.audio.length, Math.floor((b / 1000) * AUDIO_RATE) * bpf);
  const dir = mkdtempSync(join(tmpdir(), "fm1-lab-audio-"));
  try {
    writeFileSync(join(dir, "in.wav"), toWav(run._raw.audio.subarray(from, to)));
    const w = wrap(dir, [], ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, "in.wav"), "-c:a", "aac", "-b:a", "64k",
      "-movflags", "+faststart", join(dir, "out.m4a")]);
    execFileSync(w.cmd, w.args, { stdio: ["ignore", "ignore", "pipe"] });
    const m4a = readFileSync(join(dir, "out.m4a"));
    writeFileSync(outPath, m4a);
    return m4a.length;
  } catch { return null; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

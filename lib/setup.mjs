// setup.mjs — where fm1-lab's components live, whether each is ready, and how to make it.
//   emu        the emulator, built from vendor/fm1-emu with patches/        (tools/setup-emu.sh, a minute)
//   toolchain  the pi32v2-llvm compiler, built from reviewed source        (tools/setup-toolchain.sh, 1-2 hours)
//   sdk        the three AC79 SDK files packages contain, hash-checked     (tools/setup-sdk.sh, seconds)
//   python     a venv with Pillow for firmware builds' generators          (tools/setup-python.sh, seconds)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ROOT, emulatorPath } from "./emu.mjs";

const W = join(ROOT, ".work");
const SDK_FILES = {
  "uboot.boot": "4e3b4c220dc96641cb5a723f41e68ce41d5261ae9434bb33fbd7f2c59976ded4",
  "cfg_tool.bin": "276579954f076886a6a7694f65dc71c034a63a2c204b76749065c0ac7b010d1b",
  "cfg/eq_cfg_hw.bin": "41167491bffed4651750719c973d2758adeb9021a5670d02d6a53c85ed80ea7d",
};

export const paths = {
  toolchain() {
    const d = join(W, "toolchain");
    const hit = existsSync(d) && readdirSync(d).find((n) => /^pi32v2-llvm-dropin-[0-9a-f]+-[0-9a-f]+$/.test(n));
    return hit ? join(d, hit) : null;
  },
  sdk: () => join(W, "sdk"),
  python: () => join(W, "pyenv", "bin", "python"),
  /** The Python installation the venv runs on (the sandbox must be able to read it). */
  pythonHome() {
    try {
      const home = readFileSync(join(W, "pyenv", "pyvenv.cfg"), "utf8").match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
      return home ? dirname(home) : null;
    } catch { return null; }
  },
};

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

export const COMPONENTS = {
  emu: {
    script: "setup-emu.sh", time: "about a minute",
    check() { try { return { ok: true, detail: emulatorPath() }; } catch { return { ok: false, detail: "not built" }; } },   // emulatorPath throws when it is missing
  },
  toolchain: {
    script: "setup-toolchain.sh", time: "1-2 hours (LLVM from source)",
    check() {
      const t = paths.toolchain();
      if (!t || !existsSync(join(t, "llvm", "bin", "clang"))) return { ok: false, detail: "not built" };
      return { ok: true, detail: t };
    },
  },
  sdk: {
    script: "setup-sdk.sh", time: "seconds",
    check() {
      const d = join(paths.sdk(), "cpu", "wl82", "tools");
      const bad = Object.entries(SDK_FILES).filter(([f, h]) => !existsSync(join(d, f)) || sha256(join(d, f)) !== h).map(([f]) => f);
      return bad.length ? { ok: false, detail: `missing or wrong: ${bad.join(", ")}` } : { ok: true, detail: `${paths.sdk()} (hashes verified)` };
    },
  },
  python: {
    script: "setup-python.sh", time: "seconds",
    check() {
      const py = paths.python();
      if (!existsSync(py)) return { ok: false, detail: "no venv" };
      const r = spawnSync(py, ["-c", "import PIL, sys; print(PIL.__version__, sys.version.split()[0])"], { encoding: "utf8" });
      return r.status === 0 ? { ok: true, detail: `Pillow ${r.stdout.trim().replace(" ", ", Python ")}` } : { ok: false, detail: "Pillow missing" };
    },
  },
};

export function status() {
  return Object.fromEntries(Object.entries(COMPONENTS).map(([k, c]) => [k, c.check()]));
}

/** Make the missing components (or `only`), in order; each script's output goes to the terminal. */
export function setup(only = null, { force = false } = {}) {
  const results = {};
  for (const [k, c] of Object.entries(COMPONENTS)) {
    if (only && !only.includes(k)) continue;
    if (!force && c.check().ok) { results[k] = "ok"; continue; }
    process.stderr.write(`\n== ${k}: tools/${c.script} (${c.time})\n`);
    const r = spawnSync("bash", [join(ROOT, "tools", c.script)], { stdio: "inherit" });
    results[k] = r.status === 0 && c.check().ok ? "made" : "failed";
    if (results[k] === "failed") break;
  }
  return results;
}

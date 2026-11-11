// hosttest.mjs — an fm1-base app's own tests in fm1-base's host simulator, in fm1-lab's sandbox.
//
// fm1-base compiles the platform and the app with the Mac's C compiler into a program that simulates the FM-1 faster
// than real time (base/tools/build.py app --host), and runs test scripts against it (app/tests/*.txt: keys, knobs,
// MIDI, reboots, then `expect` checks on the app's state, the sound's level, MIDI out and what a screen reader says;
// screenshots and WAVs). It checks the app's logic, UI and sound; the device's timing, drivers and package need the
// emulator (fm1-lab run). Reviewed: docs/fm1-base-review.md. Both the build and each script run in lib/sandbox.sb,
// so the native program can't reach the network or read or write outside the project.
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { build } from "./build.mjs";
import { loadScenario } from "./scenario.mjs";
import { runScenario } from "./run.mjs";

/** Settings in an app's fm1.toml that make the build run or compile more of the app's code. */
export function appHooks(appDir) {
  const toml = readFileSync(join(appDir, "fm1.toml"), "utf8");
  return ["conf_gen", "gen", "o2", "ir_pass", "asm", "net"].filter((k) => {
    const v = toml.match(new RegExp(`^${k}\\s*=\\s*([^#\\n]*)`, "m"))?.[1]?.trim();
    return v != null && !/^(\[\s*\]|""|''|false)?$/.test(v);   // set to something, not empty
  });
}

/**
 * @param {string} dir  an fm1-base project (fm1-lab new)
 * @param {{scripts?:string[], emu?:boolean, onOutput?:Function}} o  scripts: names in app/tests (default: all *.txt);
 *   emu: also run them on the emulated device with the app's package (lib/hostscript.mjs)
 */
export async function hostTest(dir, o = {}) {
  const lab = existsSync(join(dir, "fm1lab.json")) ? JSON.parse(readFileSync(join(dir, "fm1lab.json"), "utf8")) : {};
  const base = lab.base || "base", app = lab.app || "app";
  if (!existsSync(join(dir, base, "tools", "build.py")) || !existsSync(join(dir, app, "fm1.toml")))
    throw new Error(`${dir} is not an fm1-base project (fm1-lab new makes one)`);
  const t0 = Date.now();
  const b = await build(dir, { cmd: `python ${base}/tools/build.py ${app} --host`, packages: false, onOutput: o.onOutput });
  if (!b.ok) return { ok: false, stage: "build", build: b, scripts: [] };
  const hostDir = join(dir, app, "build", "host");
  const bin = existsSync(hostDir) && readdirSync(hostDir).find((n) => n.endsWith("_host"));
  if (!bin) return { ok: false, stage: "build", build: { ...b, tail: `no *_host program in ${hostDir}\n${b.tail}` }, scripts: [] };

  const testsDir = join(dir, app, "tests");
  const names = o.scripts?.length ? o.scripts : readdirSync(testsDir).filter((n) => n.endsWith(".txt")).sort();
  const scripts = [];
  for (const n of names) {
    const name = basename(n, ".txt"), out = join(hostDir, "out", name);
    mkdirSync(out, { recursive: true });
    let text = "";
    const r = await build(dir, { cmd: `${app}/build/host/${bin} ${app}/tests/${name}.txt ${app}/build/host/out/${name}`, packages: false,
                                 onOutput: (s) => { text += s; } });
    const lines = text.split("\n");
    scripts.push({
      name, ok: r.exitCode === 0, exitCode: r.exitCode, out,
      // the script's assertions (the simulator prints only the ones that fail)
      checks: readFileSync(join(testsDir, `${name}.txt`), "utf8").split("\n").filter((l) => /^\s*(expect\w*|said\w*|unsaid)\b/.test(l)).length,
      failed: lines.filter((l) => /^FAIL\b/.test(l)),
      summary: lines.filter((l) => /^host:/.test(l)).pop() || "", log: r.log,
    });
  }
  // the same scripts on the emulated device, with the app's real package
  let pkg = null;
  if (o.emu) {
    const fb = await build(dir, {});
    if (!fb.ok) return { ok: false, stage: "package", build: fb, scripts };
    pkg = fb.outputs[0].path;
    for (const t of scripts) {
      const sc = loadScenario(join(testsDir, `${t.name}.txt`));
      const r = await runScenario(pkg, sc, { out: join(dir, app, "build", "lab", `test-${t.name}`) });
      t.emu = { ok: r.pass, checks: r.checks.length, failed: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
                simulatorOnly: (sc.skipped || []).length, out: join(dir, app, "build", "lab", `test-${t.name}`) };
    }
  }
  const ok = scripts.every((s) => s.ok && (!s.emu || s.emu.ok));
  return { ok, stage: "tests", seconds: +((Date.now() - t0) / 1000).toFixed(1), build: b, program: join(hostDir, bin), package: pkg, hooks: appHooks(join(dir, app)), scripts };
}

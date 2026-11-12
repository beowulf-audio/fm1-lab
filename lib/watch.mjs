// watch.mjs — rebuild and retest on every save.
//
// A round: build (sandboxed) → the app's host-simulator tests (fm1-base projects) → the scenario in the emulator → both
// flash chips (the original and the UC25HQ80 in newer units) → where it writes its flash (fm1-lab map: never the boot head, the radio calibration
// or key_mac, nothing the update loader would erase) → compare with the last build that passed. It stops at the first stage that fails; a passing round's package becomes the
// one the next is compared with. Changes in build output (build/, dist/, .git, node_modules) don't start a round.
import { watch as fsWatch, existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "./emu.mjs";
import { build } from "./build.mjs";
import { hostTest } from "./hosttest.mjs";
import { runScenario } from "./run.mjs";
import { compare } from "./compare.mjs";
import { loadScenario, SMOKE } from "./scenario.mjs";
import { describe } from "./check.mjs";
import { describeSizes } from "./sizes.mjs";
import { brickTest } from "./brick.mjs";
import { flashMap } from "./flashmap.mjs";

const IGNORE = /(^|\/)(build|dist|\.git|node_modules|venv|\.venv|out)(\/|$)|\.(o|elf|bin|fwsc|wav|png|log|json)$|~$|\.swp$|\.DS_Store$/;

/** One round. @returns {{ok:boolean, stage:string, lines:string[], package?:string}} */
export async function round(dir, o = {}) {
  const lines = [], say = (s) => { lines.push(s); o.onLine?.(s); };
  const t0 = Date.now();
  const b = await build(dir, { profile: o.profile, release: o.release, cmd: o.cmd });
  if (!b.ok) {
    say(`build   FAILED (exit ${b.exitCode}) · log ${b.log}`);
    // the compiler's own error lines (file:line: error: ...), from the whole log; else the end of it
    const all = readFileSync(b.log, "utf8").split("\n");
    const errs = all.filter((l) => /\berror:/.test(l)).slice(0, 8);
    for (const l of errs.length ? errs : b.tail.split("\n").slice(-8)) say(`        ${l.replace(dir + "/", "")}`);
    return { ok: false, stage: "build", lines };
  }
  const x = b.outputs[0];
  say(`build   ok ${b.seconds} s · ${x.rel} · ${x.size ? describeSizes(x.size, x.previous) : describe(x.check)}`);

  const lab = existsSync(join(dir, "fm1lab.json")) ? JSON.parse(readFileSync(join(dir, "fm1lab.json"), "utf8")) : {};
  if (lab.kind === "fm1-base" && o.hostTests !== false) {
    const t = await hostTest(dir);
    if (!t.ok) {
      say(`test    FAILED in the host simulator`);
      for (const s of t.scripts.filter((s) => !s.ok)) for (const f of s.failed.slice(0, 5)) say(`        ${s.label} ${f}`);
      if (t.stage === "build" && t.build) say(`        ${t.build.tail.split("\n").slice(-5).join("\n        ")}`);
      return { ok: false, stage: "test", lines };
    }
    say(`test    ok · ${t.scripts.map((s) => `${s.name} (${s.checks} checks)`).join(", ")} · host simulator ${t.seconds} s`);
  }

  const scPath = o.scenario || (lab.scenario && join(dir, lab.scenario));
  const sc = scPath && existsSync(scPath) ? loadScenario(scPath) : SMOKE;
  const r = await runScenario(x.path, sc, { out: join(ROOT, ".work", "watch", "last-run") });
  const failed = r.checks.filter((c) => !c.ok);
  if (!r.pass) {
    say(`run     FAILED ${sc.name}: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ") || r.fault || `exit ${r.exitCode}`}`);
    return { ok: false, stage: "run", lines };
  }
  say(`run     ok ${sc.name} in the emulator · peak ${r.audio.afterFirstInput.peakDb} dBFS · screen from ${r.screen.firstContentMs} ms`);

  // both flash chips: the original Puya and the UC25HQ80 in newer units (a firmware that accepts only one stops saving)
  if (o.flash !== false) {
    const b = await brickTest(x.path);
    if (b.verdict === "fail") { say(`flash   FAILED on the newer chip (UC25HQ80): ${b.reason}`); return { ok: false, stage: "flash", lines }; }
    say(`flash   ${b.verdict === "pass" ? "ok on both chips (Puya, UC25HQ80)" : `${b.verdict}: ${b.reason}`}`);
  }

  // where it writes: an error (the boot head, the radio calibration, key_mac, the app area, an update record's shape)
  // stops the round; shared places are listed once a round as notes
  if (o.flash !== false) {
    const m = await flashMap(x.path);
    const err = m.findings.filter((f) => f.level === "error"), warn = m.findings.filter((f) => f.level === "warn");
    if (err.length) { for (const f of err) say(`map     ERROR ${f.text}`); return { ok: false, stage: "map", lines }; }
    say(`map     ${m.ranges.length ? `writes ${m.ranges.map((r) => `0x${r.lo.toString(16)}..0x${(r.hi - 1).toString(16)}`).join(", ")}` : "no flash writes in the run"}${warn.length ? "" : ", nothing in the way"}`);
    for (const f of warn) say(`map     warn ${f.text}`);
  }

  const key = createHash("sha1").update(resolve(dir)).digest("hex").slice(0, 12);
  const goodDir = join(ROOT, ".work", "watch", key), good = join(goodDir, "last-good.fwsc");
  if (existsSync(good) && o.compare !== false) {
    const c = await compare(good, x.path, sc, {});
    const marks = { regression: "REGRESSION", different: "changed", same: "same" };
    say(`compare ${marks[c.verdict]} vs the last good build${c.regressions.length || c.differences.length ? ":" : ""}`);
    for (const m of c.regressions) say(`        ✗ ${m}`);
    for (const m of c.differences.slice(0, 6)) say(`        ~ ${m}`);
    if (c.verdict === "regression") return { ok: false, stage: "compare", lines };
  }
  mkdirSync(goodDir, { recursive: true });
  copyFileSync(x.path, good);
  say(`done    ${((Date.now() - t0) / 1000).toFixed(1)} s · this build is now the one the next is compared with`);
  return { ok: true, stage: "done", lines, package: x.path };
}

/** Watch `dir`; a round on start and after each burst of saves. @returns {{stop:Function, idle:Function}} */
export function watchProject(dir, o = {}) {
  dir = resolve(dir);
  let timer = null, running = false, again = false, changed = new Set(), stopped = false, waiters = [];
  const go = async (why) => {
    if (running) { again = true; return; }
    running = true;
    o.onRound?.(why);
    try { const r = await round(dir, o); o.onResult?.(r); }
    catch (e) { o.onLine?.(`error   ${e.message}`); }
    running = false;
    if (again && !stopped) { again = false; const files = [...changed]; changed.clear(); return go(files.join(", ")); }
    waiters.splice(0).forEach((f) => f());
  };
  const w = fsWatch(dir, { recursive: true }, (_, file) => {
    if (!file || IGNORE.test(file)) return;
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => { const files = [...changed]; changed.clear(); go(files.join(", ")); }, o.debounceMs ?? 400);
  });
  go("start");
  return {
    stop() { stopped = true; clearTimeout(timer); w.close(); },
    idle: () => new Promise((res) => (running ? waiters.push(res) : res())),
  };
}

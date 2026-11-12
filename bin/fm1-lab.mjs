#!/usr/bin/env node
// fm1-lab — headless test bench for M-VAVE FM-1 firmware, built on fm1-emu.
//   fm1-lab setup      [--check] [--force] [emu|toolchain|sdk|python ...]
//   fm1-lab build      DIR [--profile P] [--release X] [--cmd "..."] [--root DIR] [--out DIR] [--json OUT] [--run]
//   fm1-lab new        NAME [--dir PARENT] [--id NN] [--author NAME] [--git-name N --git-email E] [--gh-credential] [--no-build]
//   fm1-lab test       [DIR] [--emu] [SCRIPT...]   an fm1-base app's tests in its host simulator (--emu: and the emulator)
//   fm1-lab watch      [DIR] [--scenario S] [--profile P] [--cmd '...'] [--no-test] [--no-flash] [--no-compare]
//   fm1-lab sweep      PATH|@LIST... --out DIR [--brick] [--jobs N] [--no-audio] [--force]
//   fm1-lab inspect    FILE.fwsc...
//   fm1-lab boot       FILE.fwsc [--ms 4000] [--jedec b36014] [--keys 'T:PLAY,...'] [--png out.png]
//   fm1-lab brick-test FILE.fwsc... [--ms 4000] [--json report.json] [--png-dir DIR]
//   fm1-lab profile    [SCENARIO.yaml] FILE.fwsc [--syms FILE] [--clocks 180,120,...] [--json OUT]
//   fm1-lab compare    [SCENARIO.yaml] A.fwsc B.fwsc [--out DIR] [--strict] [--headroom] [--identical]
// Exit codes (compare): 0 no regression, 1 regression.
// Exit codes (brick-test): 0 all pass, 1 any fail, 2 any inconclusive/warn/error (none failing).
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { boot } from "../lib/emu.mjs";
import { ppmToPng } from "../lib/image.mjs";
import { loadScenario, SMOKE } from "../lib/scenario.mjs";
import { runScenario } from "../lib/run.mjs";
import { parseSpec, prepare } from "../lib/resources.mjs";
import { brickTest } from "../lib/brick.mjs";
import { DEFAULT_KEYS } from "../lib/brick.mjs";
import { flashMap, describe as describeMap } from "../lib/flashmap.mjs";
import { toKeys } from "../lib/scenario.mjs";
import { profile } from "../lib/profile.mjs";
import { compare } from "../lib/compare.mjs";
import { runReport, profileReport, compareReport } from "../lib/report.mjs";
import { status as setupStatus, setup, COMPONENTS } from "../lib/setup.mjs";
import { build } from "../lib/build.mjs";
import { checkPackage, describe } from "../lib/check.mjs";
import { newProject, commitProject } from "../lib/new.mjs";
import { hostTest } from "../lib/hosttest.mjs";
import { describeSizes } from "../lib/sizes.mjs";
import { watchProject } from "../lib/watch.mjs";
import { sweep, collect } from "../lib/sweep.mjs";

// Node 24 can deadlock inside process.exit() (joining a platform worker thread), so commands set process.exitCode and
// end by themselves. Piped into head and the like: ignore the closed pipe.
for (const st of [process.stdout, process.stderr]) st.on("error", (e) => { if (e.code !== "EPIPE") throw e; });

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opt = (name, def = null) => { const i = argv.indexOf(name); if (i < 0) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const usage = () => { console.error("usage: fm1-lab setup [--check] [--force] [emu|toolchain|sdk|python ...]\n       fm1-lab build DIR [--profile P] [--release X] [--cmd '...'] [--root DIR] [--out DIR] [--json OUT] [--run]\n       fm1-lab new NAME [--dir PARENT] [--id NN] [--author NAME] [--git-name N --git-email E] [--gh-credential] [--no-build]\n       fm1-lab test [DIR] [--emu] [SCRIPT...]\n       fm1-lab watch [DIR] [--scenario S] [--profile P] [--cmd '...'] [--no-test] [--no-flash] [--no-compare]\n       fm1-lab sweep PATH|@LIST... --out DIR [--brick] [--preview | --gif --m4a] [--tours MAP.json] [--jobs N] [--no-audio] [--force]\n       fm1-lab inspect FILE.fwsc...\n       fm1-lab run [SCENARIO.yaml] FILE.fwsc [--out DIR] [--flash puya|uc25|HEX] [--resources FILE@0xADDR | entry:TYPE@0xADDR] [--strict] [--html OUT]\n       fm1-lab map [SCENARIO.yaml] FILE.fwsc [--ms N] [--flash HEX] [--json OUT]\n       fm1-lab boot FILE.fwsc [--ms N] [--jedec HEX] [--keys SCRIPT] [--png OUT]\n       fm1-lab brick-test FILE.fwsc... [--ms N] [--json OUT] [--png-dir DIR]\n       fm1-lab profile [SCENARIO.yaml] FILE.fwsc [--syms FILE] [--clocks 180,120,...] [--json OUT] [--html OUT]\n       fm1-lab compare [SCENARIO.yaml] A.fwsc B.fwsc [--out DIR] [--strict] [--headroom] [--identical] [--no-retry] [--html OUT]"); process.exit(64); };
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
// before a firmware runs: is it a well-formed FM-1 package? (FM-1 Inspect's decoder)
const preflight = (...files) => {
  for (const f of files) {
    const c = checkPackage(f);
    if (!c.ok) { console.error(`${f}: ${describe(c)}`); process.exit(2); }
  }
};

if (cmd === "setup") {
  const check = flag("--check"), force = flag("--force");
  const only = argv.length ? argv : null;
  for (const k of only || []) if (!COMPONENTS[k]) usage();
  if (!check) {
    const r = setup(only, { force });
    if (Object.values(r).includes("failed")) console.error(`\nsetup stopped: ${Object.entries(r).filter(([, v]) => v === "failed").map(([k]) => k).join(", ")} failed (see above)`);
  }
  const st = setupStatus();
  console.log("");
  for (const [k, v] of Object.entries(st)) console.log(`  ${v.ok ? "ok     " : "missing"}  ${k.padEnd(10)} ${v.detail}${v.ok ? "" : `   (fm1-lab setup ${k}: ${COMPONENTS[k].time})`}`);
  // the exit code is about what was asked for (`setup emu` on CI needs no toolchain), or everything when nothing was named
  process.exitCode = Object.entries(st).filter(([k]) => !only || only.includes(k)).every(([, v]) => v.ok) ? 0 : 1;
} else if (cmd === "new") {
  const dir = opt("--dir"), id = opt("--id"), author = opt("--author"), gitName = opt("--git-name"), gitEmail = opt("--git-email");
  const noBuild = flag("--no-build"), ghCredential = flag("--gh-credential");
  const name = argv[0]; if (!name) usage();
  let p;
  try { p = await newProject(name, { dir: dir || undefined, id: id || undefined, author: author ?? undefined, gitName: gitName || undefined, gitEmail: gitEmail || undefined,
                                     ghCredential, commit: noBuild, onStep: (m) => console.log(`  .. ${m}`) }); }
  catch (e) { console.error(`fm1-lab new: ${e.message}`); process.exit(2); }
  console.log(`\nNEW    ${p.dir} · ${p.NAME} · identity ${p.prefix} · fm1-base's template on fm1-base's own Bluetooth stack`);
  if (!noBuild) {
    let r;
    try { r = await build(p.dir, { onOutput: () => {} }); } catch (e) { console.error(`  build: ${e.message}`); process.exit(1); }
    const x = r.outputs[0];
    console.log(`${r.ok ? "BUILT " : "FAILED"} ${r.seconds} s · ${r.sandbox ? "sandboxed" : "NOT sandboxed (FM1_LAB_SANDBOX=off)"} · log ${r.log}`);
    if (!r.ok) { console.log(r.tail); console.log(`  (not committed: fix the build, then commit in ${p.dir})`); process.exit(1); }
    console.log(`  ${x.rel}: ${describe(x.check)}`);
    const out = join(p.dir, "app", "build", "lab");
    const rr = await runScenario(x.path, loadScenario(p.scenario), { out });
    console.log(`  ${rr.pass ? "PASS" : "FAIL"} scenarios/smoke.yaml: ${rr.checks.map((c) => `${c.name} ${c.ok ? "ok" : "FAIL"}`).join(", ")} · screenshots and audio.wav in ${out}`);
    const bt = await brickTest(x.path);   // both flash chips
    console.log(`  ${bt.verdict === "pass" ? "PASS" : bt.verdict.toUpperCase()} both flash chips (Puya, UC25HQ80): ${bt.reason}`);
    process.exitCode = rr.pass && bt.verdict === "pass" ? 0 : 1;
    console.log(`  first commit ${commitProject(p.dir, p.NAME, p.prefix)} (with the firmware.json the build wrote)`);
  }
  console.log(`\nnext: edit app/app.c, then  cd ${p.dir} && fm1-lab build . --run`);
} else if (cmd === "test") {
  const emu = flag("--emu");
  const dir = argv[0] || ".";
  let r;
  try { r = await hostTest(dir, { scripts: argv.slice(1), emu }); } catch (e) { console.error(`fm1-lab test: ${e.message}`); process.exit(2); }
  if (r.stage === "build") { console.log(`FAILED building the host simulator · log ${r.build.log}\n${r.build.tail}`); process.exit(1); }
  if (r.stage === "package") { console.log(`FAILED building the package for the emulator · log ${r.build.log}\n${r.build.tail}`); process.exit(1); }
  if (r.hooks.length) console.log(`  note: fm1.toml runs or compiles more of the app's code (${r.hooks.join(", ")}): fine for your own app; read them in anyone else's`);
  for (const t of r.scripts) {
    console.log(`  ${t.ok ? "PASS" : "FAIL"}  tests/${t.name}.txt · ${t.checks} checks${t.summary ? ` · ${t.summary.replace(/^host:\s*/, "")}` : ""} · output in ${t.out}`);
    for (const f of t.failed.slice(0, 10)) console.log(`        ${f}`);
    if (t.emu) {
      console.log(`  ${t.emu.ok ? "PASS" : "FAIL"}  tests/${t.name}.txt on the emulated device · ${t.emu.checks} checks (${t.emu.simulatorOnly} of the script's lines are simulator-only) · output in ${t.emu.out}`);
      for (const f of t.emu.failed.slice(0, 10)) console.log(`        ${f}`);
    }
  }
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.scripts.length} test scripts in the host simulator${emu ? " and on the emulated device" : ""} · ${r.seconds} s · sandboxed`);
  process.exitCode = r.ok ? 0 : 1;
} else if (cmd === "watch") {
  const scenario = opt("--scenario"), profile = opt("--profile"), wcmd = opt("--cmd"), noTest = flag("--no-test"), noFlash = flag("--no-flash"), noCompare = flag("--no-compare");
  const dir = argv[0] || ".";
  const time = () => new Date().toTimeString().slice(0, 8);
  console.log(`watching ${dir} · Ctrl-C to stop`);
  watchProject(dir, {
    scenario: scenario || undefined, profile: profile || undefined, cmd: wcmd || undefined, hostTests: !noTest, flash: !noFlash, compare: !noCompare,
    onRound: (why) => console.log(`\n${time()}  ${why === "start" ? "first round" : `changed: ${why}`}`),
    onLine: (l) => console.log(`  ${l}`),
    onResult: (r) => { console.log(`${time()}  ${r.ok ? "PASS" : `FAIL at ${r.stage}`}`); if (!r.ok) process.stdout.write("\x07"); },
  });
} else if (cmd === "sweep") {
  const out = opt("--out"), jobs = opt("--jobs"), toursFile = opt("--tours"), brick = flag("--brick"), previews = flag("--preview"), gifs = flag("--gif") || previews,
        m4a = flag("--m4a") || previews, noAudio = flag("--no-audio"), force = flag("--force");
  const tours = toursFile ? JSON.parse(readFileSync(toursFile, "utf8")) : undefined;
  if (!out || !argv.length) usage();
  const files = collect(argv);
  console.log(`sweep: ${files.length} .fwsc files${brick ? ", with the UC25HQ80 flash test" : ""} -> ${out}`);
  let shown = 0;
  const r = await sweep(files, { out, jobs: jobs ? +jobs : undefined, brick, gif: gifs, m4a, tours, audio: !noAudio, force, onProgress: (p) => {
    if (p.done === p.total || p.done - shown >= 25) { shown = p.done; console.log(`  ${p.done}/${p.total} · ${Math.round(p.seconds)} s${p.reused ? ` · ${p.reused} from earlier` : ""}`); }
  } });
  const s = r.summary;
  console.log(`done: ${s.distinct} distinct · ${s.boots} boot · ${s.sound} make sound · ${s.crashes} crash · ${s.invalid} not packages${s.brick ? ` · UC25 flash: ${Object.entries(s.brick).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""} · ${s.seconds} s`);
  console.log(`gallery ${join(r.out, "index.html")} · data ${join(r.out, "results.json")}${brick ? ` · ${join(r.out, "brick.json")}` : ""}`);
} else if (cmd === "inspect") {
  if (!argv.length) usage();
  let bad = 0;
  for (const f of argv) {
    const c = checkPackage(f); if (!c.ok) bad++;
    console.log(`${c.ok ? "ok  " : "BAD "}  ${f}\n      ${describe(c)}`);
    for (const x of c.findings) console.log(`      ${x.level.padEnd(4)} ${x.area}: ${x.text}`);
  }
  process.exitCode = bad ? 1 : 0;
} else if (cmd === "build") {
  const profile = opt("--profile"), release = opt("--release"), bcmd = opt("--cmd"), root = opt("--root"), out = opt("--out"), jsonOut = opt("--json"), runIt = flag("--run");
  const dir = argv[0]; if (!dir) usage();
  let r;
  try {
    r = await build(dir, { profile, release, cmd: bcmd, root, out, args: argv.slice(1), onOutput: (s) => process.stderr.write(s) });
  } catch (e) { console.error(`fm1-lab build: ${e.message}`); process.exit(2); }
  console.log(`\n${r.ok ? "BUILT " : "FAILED"} ${r.project} · ${r.recipe} · ${r.seconds} s · exit ${r.exitCode} · ${r.sandbox ? "sandboxed" : "NOT sandboxed (FM1_LAB_SANDBOX=off)"} · log ${r.log}`);
  if (!r.outputs.length) console.log("  no .fwsc was made");
  for (const x of r.outputs) {
    console.log(`  ${x.check.ok ? "ok " : "BAD"} ${x.rel}${x.copied ? ` -> ${x.copied}` : ""}${x.alsoAt.length ? `  (the same file also at ${x.alsoAt.join(", ")})` : ""}\n      ${describe(x.check)} · sha256 ${x.sha256.slice(0, 12)}`);
    if (x.size) console.log(`      size: ${describeSizes(x.size, x.previous)}`);
    for (const f of x.check.findings.filter((f) => f.level !== "ok")) console.log(`      ${f.level.padEnd(4)} ${f.area}: ${f.text}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(r, null, 2));
  if (r.ok && runIt) {
    const f = r.outputs[0].copied || r.outputs[0].path, rr = await runScenario(f, SMOKE, {});
    console.log(`  smoke run: ${rr.pass ? "PASS" : "FAIL"} · screen from ${rr.screen.firstContentMs} ms · peak ${rr.audio.afterFirstInput.peakDb} dBFS`);
    if (!rr.pass) r.ok = false;
  }
  process.exitCode = r.ok ? 0 : 1;
} else if (cmd === "boot") {
  const ms = Number(opt("--ms", 4000)), jedec = opt("--jedec"), keys = opt("--keys"), pngOut = opt("--png");
  const file = argv[0]; if (!file) usage();
  preflight(file);
  const r = await boot(file, { ms, jedec, keys });
  if (pngOut && r.panel) writeFileSync(pngOut, ppmToPng(r.panel));
  console.log(JSON.stringify({ file, ms, jedec: jedec || "856014", exitCode: r.code, flash: r.flash, leds: r.leds, audioPeak: r.audioPeak, wallMs: r.wallMs }, null, 2));
  process.exitCode = r.code === 0 ? 0 : 2;
} else if (cmd === "map") {
  // where a firmware writes its flash, checked against the FM-1's flash contract (lib/flashmap.mjs)
  const jsonOut = opt("--json"), flash = opt("--flash");
  const [a, b] = argv; if (!a) usage();
  const [scenPath, fwsc] = b ? [a, b] : [null, a];
  preflight(fwsc);
  const sc = scenPath ? loadScenario(scenPath) : null;
  const ms = Number(opt("--ms", sc ? sc.ms : 8000));
  const m = await flashMap(fwsc, { ms, keys: sc ? toKeys(sc) : DEFAULT_KEYS, jedec: flash || (sc && sc.flash) || undefined });
  console.log(`${m.ok ? "OK  " : "FAIL"}  ${basename(fwsc)} · ${sc ? sc.name : "two octave presses, then time to save"} · ${ms} ms`);
  for (const l of describeMap(m)) console.log(`  ${l}`);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ tool: "fm1-lab map", date: new Date().toISOString(), firmware: basename(fwsc), ...m }, null, 2));
  process.exitCode = m.ok ? 0 : 1;
} else if (cmd === "brick-test") {
  const ms = Number(opt("--ms", 8000)), jsonOut = opt("--json"), pngDir = opt("--png-dir");
  if (!argv.length) usage();
  const results = [];
  for (const f of argv) {
    const r = await brickTest(f, { ms });
    if (pngDir) {
      mkdirSync(pngDir, { recursive: true });
      for (const [k, p] of Object.entries(r._panels)) if (p) writeFileSync(join(pngDir, `${basename(f, ".fwsc")}.${k}.png`), ppmToPng(p));
    }
    delete r._panels;
    results.push(r);
    const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", inconclusive: "????", error: "ERR " }[r.verdict];
    console.log(`${mark}  ${basename(f).padEnd(34)} puya ${String(r.puya.flash.reads + r.puya.flash.writes).padStart(4)} ops  uc25 ${String(r.uc25.flash.reads + r.uc25.flash.writes).padStart(4)} ops   ${r.reason}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ tool: "fm1-lab brick-test", date: new Date().toISOString(), results }, null, 2));
  const v = results.map((r) => r.verdict);
  process.exitCode = v.includes("fail") ? 1 : v.every((x) => x === "pass") ? 0 : 2;
} else if (cmd === "run") {
  const out = opt("--out"), flash = opt("--flash"), html = opt("--html"), res = opt("--resources"); const strict = argv.includes("--strict"); if (strict) argv.splice(argv.indexOf("--strict"), 1);
  const [a, b] = argv; if (!a) usage();
  const [scenPath, fwsc] = b ? [a, b] : [null, a];
  const sc = scenPath ? loadScenario(scenPath) : SMOKE;
  preflight(fwsc);
  let resources;   // checked before anything runs: the file's header, and the address
  try { if (res) { resources = parseSpec(res); prepare(resources, fwsc); } }
  catch (e) { console.error(e.code === "ENOENT" ? `resources: no file ${resources.file}` : e.message); process.exit(64); }
  const r = await runScenario(fwsc, sc, { out: out || undefined, strict: strict || undefined, jedec: flash || undefined, resources });
  if (html) writeFileSync(html, runReport(r));
  delete r._raw;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.firmware} · ${r.scenario} · ${r.ms} ms in ${r.wallMs} ms (${r.speed}x real time)`);
  for (const c of r.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(17)} ${c.detail}`);
  console.log(`  audio: peak ${r.audio.all.peakDb} dBFS, rms ${r.audio.all.rmsDb} dBFS, silent ${Math.round(r.audio.all.silentShare * 100)}% · screen: ${r.screen.distinctFrames} distinct frames · flash: ${r.flashOps.reads} reads, ${r.flashOps.writes} writes`);
  if (out) console.log(`  report files in ${out}`);
  if (html) console.log(`  HTML report: ${html}`);
  process.exitCode = r.pass ? 0 : 1;
} else if (cmd === "profile") {
  const syms = opt("--syms"), jsonOut = opt("--json"), clocks = opt("--clocks"), html = opt("--html");
  const [a, b] = argv; if (!a) usage();
  const [scenPath, fwsc] = b ? [a, b] : [null, a];
  const sc = scenPath ? loadScenario(scenPath) : SMOKE;
  preflight(fwsc);
  const t0 = Date.now();
  const p = await profile(fwsc, sc, { syms: syms || undefined, clocks: clocks ? clocks.split(",").map(Number) : undefined,
                                      onProgress: (m) => process.stderr.write(`  .. ${m}\n`) });
  if (html) writeFileSync(html, profileReport(p));
  delete p._ref;
  const h = p.headroom;
  console.log(`${p.firmware} · ${p.scenario} · profiled ${p.window[0]}–${p.window[1]} ms · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`  headroom: ${h.headroomShare == null ? "n/a" : Math.round(h.headroomShare * 100) + "% of the 240 MHz chip unused"} · ${h.note}`);
  if (h.warning) console.log(`  warning: ${h.warning}`);
  for (const s of h.steps.slice(1)) console.log(`    ${String(s.mhz).padStart(3)} MHz  ${s.keepsUp ? "keeps up" : "FAILS   "}  level ${s.rmsDb >= 0 ? "+" : ""}${s.rmsDb} dB · spectrum ${s.bandDb} dB · stale ${(s.stale * 100).toFixed(1)}%${s.phaseDependent ? " · (on the second input phase)" : ""}`);
  console.log(`  interrupts: ${Math.round((p.isrShare ?? 0) * 100)}% of core 0's time · boot to first screen: ${p.bootMs} ms`);
  for (const [k, c] of [["core 0", p.hotspots.core0], ["core 1", p.hotspots.core1]]) {
    if (!c.running) { console.log(`  ${k}: not running`); continue; }
    console.log(`  ${k}: ${Math.round(c.busyShare * 100)}% outside wait loops; where its time goes:`);
    for (const r of c.regions.filter((r) => r.share >= 0.005).slice(0, 8)) console.log(`    ${(r.share * 100).toFixed(1).padStart(5)}%  ${"█".repeat(Math.max(1, Math.round(r.share * 30))).padEnd(30)} ${r.name} (${r.area}, ${r.bytes} B)${r.likelyWait ? "  wait loop?" : ""}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(p, null, 2));
  if (html) console.log(`  HTML report: ${html}`);
  process.exitCode = 0;
} else if (cmd === "compare") {
  const out = opt("--out"), html = opt("--html"), strict = flag("--strict"), headroom = flag("--headroom"), identical = flag("--identical"), noRetry = flag("--no-retry");
  if (argv.length < 2 || argv.length > 3) usage();
  const [scenPath, a, b] = argv.length === 3 ? argv : [null, ...argv];
  const sc = scenPath ? loadScenario(scenPath) : SMOKE;
  preflight(a, b);
  const r = await compare(a, b, sc, { out: out || undefined, strict, headroom, identical, retry: !noRetry, onProgress: (m) => process.stderr.write(`  .. ${m}\n`) });
  if (html) writeFileSync(html, compareReport(r));
  delete r._runs;
  const mark = { regression: "REGRESSION", different: "DIFFERENT ", same: "SAME      " }[r.verdict];
  console.log(`${mark} ${r.a} → ${r.b} · ${r.scenario}`);
  for (const m of r.regressions) console.log(`  ✗ ${m}`);
  for (const m of r.differences) console.log(`  ~ ${m}`);
  for (const m of r.timingDependent) console.log(`  ? timing-dependent, not counted: ${m}`);
  if (r.retried) console.log(`  (checked again with inputs 37 ms later: only what was found both times counts)`);
  console.log(`  audio: ${r.audio.identical ? "bit-identical" : `level ${r.audio.a.rmsDb} → ${r.audio.b.rmsDb} dBFS rms, peak ${r.audio.a.peakDb} → ${r.audio.b.peakDb}, waveform match ${r.audio.similarity}`}`);
  console.log(`  boot: ${r.cpu.bootMsA} → ${r.cpu.bootMsB} ms · interrupts: ${Math.round((r.cpu.isrShareA ?? 0) * 100)}% → ${Math.round((r.cpu.isrShareB ?? 0) * 100)}%${r.cpu.headroomA != null ? ` · headroom ${Math.round(r.cpu.headroomA * 100)}% → ${Math.round(r.cpu.headroomB * 100)}%` : ""}`);
  if (out) console.log(`  report files in ${out}`);
  if (html) console.log(`  HTML report: ${html}`);
  process.exitCode = r.regressions.length ? 1 : 0;
} else usage();

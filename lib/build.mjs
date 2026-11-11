// build.mjs — build an FM-1 firmware project with fm1-lab's compiler and SDK files, in the sandbox.
//
// The build runs under lib/sandbox.sb (no network; writes only inside the project; nothing in HOME readable except the
// project, fm1-lab and the Python installation) with a clean environment: only PATH (the venv, the system, Homebrew),
// HOME, the toolchain and SDK paths, JIELI_DOCKER=0 and no global git config. Every .fwsc the build makes is then
// checked with FM-1 Inspect's decoder and analysis.
//
// What to run is found in the project:
//   --cmd "..."            any command (sh -c), run in the project directory
//   fm1lab.json / base+app an fm1-base project (fm1-lab new): python base/tools/build.py app --sdk SDK [--release X]
//   tools/optimist.py      Optimist and its forks: python tools/optimist.py package --profile P [--release X] --out dist
//   build.sh               the Felucca family: sh ./build.sh [args]
// A build can read and write only the project directory (--root to widen it to a parent, e.g. a repository whose
// example is built from a subdirectory).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, copyFileSync, createWriteStream, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { ROOT } from "./emu.mjs";
import { wrap } from "./sandbox.mjs";
import { paths, status } from "./setup.mjs";
import { checkPackage } from "./check.mjs";
import { createHash } from "node:crypto";
import { buildSizes, recordBuild } from "./sizes.mjs";

/** The published profiles of an Optimist-style project (config/profiles/*.config with "# publish: yes"). */
export function optimistProfiles(dir) {
  const d = join(dir, "config", "profiles");
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".config") && /^# *publish: *yes/m.test(readFileSync(join(d, f), "utf8"))).map((f) => f.replace(/\.config$/, ""));
}

/** What would run, without running it. */
export function recipe(dir, o = {}) {
  if (o.cmd) return { kind: "command", argv: ["sh", "-c", o.cmd] };
  // an fm1-base project (fm1-lab new): fm1-base's build of the app directory
  const lab = existsSync(join(dir, "fm1lab.json")) ? JSON.parse(readFileSync(join(dir, "fm1lab.json"), "utf8")) : null;
  if (lab?.kind === "fm1-base" || (existsSync(join(dir, "base", "tools", "build.py")) && existsSync(join(dir, "app", "fm1.toml")))) {
    const base = lab?.base || "base", app = lab?.app || "app";
    const argv = ["python", `${base}/tools/build.py`, app, "--sdk", paths.sdk()];
    if (o.release) argv.push("--release", o.release);
    return { kind: "fm1-base", argv, outputs: `${app}/build` };
  }
  if (existsSync(join(dir, "tools", "optimist.py"))) {
    if (!o.profile) throw new Error(`an Optimist-style project: say which --profile (published: ${optimistProfiles(dir).join(", ") || "none found"})`);
    const argv = ["python", "tools/optimist.py", "package", "--profile", o.profile, "--out", "dist"];
    if (o.release) argv.push("--release", o.release);
    return { kind: "optimist", argv, outputs: "dist" };
  }
  if (existsSync(join(dir, "build.sh"))) return { kind: "build.sh", argv: ["sh", "./build.sh", ...(o.args || [])] };
  throw new Error(`don't know how to build ${dir}: no tools/optimist.py or build.sh (use --cmd "...")`);
}

function fwscFiles(dir, since, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "venv" || e.name === ".venv") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) fwscFiles(p, since, acc);
    else if (e.name.endsWith(".fwsc") && statSync(p).mtimeMs >= since) acc.push(p);
  }
  return acc;
}

/**
 * @param {string} dir  the project
 * @param {{profile?:string, release?:string, cmd?:string, args?:string[], root?:string, out?:string, log?:string, packages?:boolean,
 *          sandbox?:boolean, onOutput?:(chunk:string)=>void}} o
 */
export async function build(dir, o = {}) {
  dir = realpathSync(resolve(dir));
  const root = o.root ? realpathSync(resolve(o.root)) : dir;
  if (relative(root, dir).startsWith("..")) throw new Error(`--root ${root} must contain the project ${dir}`);
  const st = status();
  const missing = ["toolchain", "sdk", "python"].filter((k) => !st[k].ok);
  if (missing.length) throw new Error(`not set up: ${missing.join(", ")} (fm1-lab setup ${missing.join(" ")})`);
  const r = recipe(dir, o);

  const tc = paths.toolchain(), venvBin = join(ROOT, ".work", "pyenv", "bin");
  const env = {
    HOME: homedir(), PATH: `${venvBin}:/usr/bin:/bin:/opt/homebrew/bin`, LANG: "en_US.UTF-8",
    PI32V2_LLVM_TOOLCHAIN: tc, JIELI_TOOLCHAIN: tc, AC79_SDK: paths.sdk(), JIELI_DOCKER: "0",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PYTHONDONTWRITEBYTECODE: "1",
  };
  const pyHome = paths.pythonHome();
  const envArgs = ["-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  // sandboxed (lib/sandbox.mjs); wrap() refuses where there is no sandbox. sandbox: false only for fm1-lab's own tests
  const w = o.sandbox === false ? { cmd: "/usr/bin/env", args: [...envArgs, ...r.argv], kind: "off" } : wrap(root, pyHome ? [pyHome] : [], "/usr/bin/env", [...envArgs, ...r.argv]);
  const useSandbox = w.kind !== "off";
  const cmd = w.cmd, argv = w.args;
  const t0 = Date.now();
  const logFile = o.log || join(ROOT, ".work", "logs", `build-${Date.now()}.log`);
  mkdirSync(join(logFile, ".."), { recursive: true });
  const log = createWriteStream(logFile);
  log.write(`# fm1-lab build ${dir}\n# ${r.argv.join(" ")}\n# sandbox: ${useSandbox ? `${w.kind}, writes only under ${root}` : "off"}\n\n`);
  let tail = "";
  const code = await new Promise((res, rej) => {
    const p = spawn(cmd, argv, { cwd: dir, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (d) => { const s = d.toString(); log.write(s); tail = (tail + s).slice(-4000); o.onOutput?.(s); };
    p.stdout.on("data", onData); p.stderr.on("data", onData);
    p.on("error", rej); p.on("close", res);
  });
  await new Promise((res) => log.end(res));

  // the packages it made: in the recipe's output directory if it has one, else anywhere in the project; a package
  // the build left in several places (intermediate copies) is listed once, with the other places
  const found = fwscFiles(r.outputs ? join(dir, r.outputs) : dir, t0 - 1000).sort((a, b) => a.length - b.length || a.localeCompare(b));
  const bySum = new Map();
  for (const f of found) {
    const sum = createHash("sha256").update(readFileSync(f)).digest("hex");
    if (bySum.has(sum)) bySum.get(sum).alsoAt.push(relative(dir, f));
    else bySum.set(sum, { path: f, rel: relative(dir, f), sha256: sum, alsoAt: [] });
  }
  const outputs = [...bySum.values()].map((x) => ({ ...x, check: checkPackage(x.path), sizes: buildSizes(x.path) }));
  for (const x of outputs) if (x.check.ok && code === 0) {
    x.size = { appBytes: x.check.appBytes, appSlot: x.check.appSlot, sizes: x.sizes, sha256: x.sha256 };
    x.previous = recordBuild(dir, x.rel, x.size);
  }
  if (o.out) {
    mkdirSync(o.out, { recursive: true });
    for (const x of outputs) { const d = join(o.out, x.rel.split("/").pop()); copyFileSync(x.path, d); x.copied = d; }
  }
  return {
    tool: "fm1-lab build", project: dir, recipe: r.kind, command: r.argv.join(" "), exitCode: code, seconds: +((Date.now() - t0) / 1000).toFixed(1),
    log: logFile, sandbox: useSandbox, outputs, tail: tail.split("\n").slice(-15).join("\n"),
    ok: code === 0 && (o.packages === false || (outputs.length > 0 && outputs.every((x) => x.check.ok))),
  };
}

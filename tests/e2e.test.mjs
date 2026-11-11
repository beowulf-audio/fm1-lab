// fm1-lab end to end: a new project through every command, as a user runs them. Needs `fm1-lab setup` done; a few
// minutes. node --test tests/e2e.test.mjs (npm run test:e2e)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { status } from "../lib/setup.mjs";
import { round } from "../lib/watch.mjs";

const LAB = fileURLToPath(new URL("..", import.meta.url));
const lab = (...args) => {
  const r = spawnSync(process.execPath, [join(LAB, "bin", "fm1-lab.mjs"), ...args], { encoding: "utf8", timeout: 600000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const ready = Object.values(status()).every((v) => v.ok);
const skip = ready ? false : "fm1-lab setup is not done";
let T, P, CRASH;

before(() => { T = mkdtempSync(join(tmpdir(), "fm1-lab-e2e-")); P = join(T, "e2e"); CRASH = join(T, "crashy"); });
after(() => { if (T && !process.env.FM1_LAB_KEEP) rmSync(T, { recursive: true, force: true }); });

test("new: a project that builds, boots, speaks and is committed", { skip }, () => {
  const r = lab("new", "e2e", "--dir", T);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BUILT/); assert.match(r.out, /PASS scenarios\/smoke\.yaml.*said "E2E" ok.*no_crash ok/);
  const git = (...a) => spawnSync("git", ["-C", P, ...a], { encoding: "utf8" }).stdout.trim();
  assert.equal(git("log", "--format=%ae", "-1"), git("config", "--get", "user.email"), "committed with the configured identity");
  assert.equal(git("status", "--short"), "", "everything committed, firmware.json too");
  assert.equal(git("config", "-f", ".gitmodules", "submodule.base.url"), "https://github.com/w0ts/fm1-base");
  assert.match(readFileSync(join(P, "app", "fm1.toml"), "utf8"), /^ble_stack = "own"/m);
});

test("test --emu: the template's scripts in the simulator and on the emulated device", { skip }, () => {
  const r = lab("test", P, "--emu");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS  tests\/basic\.txt · 49 checks/);
  assert.match(r.out, /PASS  tests\/basic\.txt on the emulated device/);
});

test("inspect: the package is a well-formed FM-1 package", { skip }, () => {
  const r = lab("inspect", join(P, "app", "build", "e2e.fwsc"));
  assert.equal(r.code, 0, r.out); assert.match(r.out, /chip key 0x980F/);
});

test("build: sizes, and what changed since the last build", { skip }, () => {
  appendFileSync(join(P, "app", "app.c"), '\nconst char e2e_pad[2048] __attribute__((used)) = "e2e";\n');
  const r = lab("build", P);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /\(\+2,048\)/);
  spawnSync("git", ["-C", P, "checkout", "-q", "app/app.c"]);
  assert.equal(lab("build", P).code, 0);
});

test("a crash: found, named, and a regression in compare", { skip }, () => {
  cpSync(P, CRASH, { recursive: true });
  const f = join(CRASH, "app", "app.c"), src = readFileSync(f, "utf8");
  const hook = '        } else {\n            app_say("BUTTON", BTN_NAME[k]);\n        }';
  assert.ok(src.includes(hook), "the template's button handler");
  writeFileSync(f, src.replace(hook, '        } else if (k == B_SEQ) {\n            ((void (*)(void))0x0EAD0000u)();\n' + hook.slice(8)));
  assert.equal(lab("build", CRASH).code, 0);
  const sc = join(T, "seq.yaml");
  writeFileSync(sc, "name: seq\nms: 4000\nsteps:\n  - { at: 2000, press: SEQ }\n  - { at: 3000, screenshot: after }\n");
  const run = lab("run", sc, join(CRASH, "app", "build", "e2e.fwsc"));
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /FAIL no_crash .*pc 0x0ead0002 \(not in the firmware's code\); returning to 0x[0-9a-f]+ in input/);
  const c = lab("compare", sc, join(P, "app", "build", "e2e.fwsc"), join(CRASH, "app", "build", "e2e.fwsc"));
  assert.equal(c.code, 1, c.out); assert.match(c.out, /REGRESSION[\s\S]*check "no_crash" passes on A, fails on B/);
});

test("compare: a build against itself is the same", { skip }, () => {
  const pkg = join(P, "app", "build", "e2e.fwsc");
  const r = lab("compare", join(P, "scenarios", "smoke.yaml"), pkg, pkg, "--identical");
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^SAME/m);
});

test("the sandbox: a build can't write HOME or reach the network", { skip }, () => {
  const probe = join(homedir(), ".fm1-lab-e2e-escape");
  const w = lab("build", P, "--cmd", `echo x > "${probe}"`);
  assert.notEqual(w.code, 0); assert.equal(existsSync(probe), false);
  const n = lab("build", P, "--cmd", "curl -sS -m 5 -o /dev/null https://example.com");
  assert.notEqual(n.code, 0);
  const s = lab("build", P, "--cmd", 'cat "$HOME/.ssh/config" > leak.txt || true; test ! -s leak.txt');
  assert.match(s.out, /Operation not permitted|No such file/);
  rmSync(join(P, "leak.txt"), { force: true });
});

test("watch: a round passes and compares with the last good build", { skip }, async () => {
  const first = await round(P, {});
  assert.equal(first.ok, true, first.lines.join("\n"));
  const second = await round(P, {});
  assert.equal(second.ok, true, second.lines.join("\n"));
  assert.ok(second.lines.some((l) => /^compare (same|changed)/.test(l)), second.lines.join("\n"));
});

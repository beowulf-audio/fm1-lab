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
  assert.match(r.out, /PASS both flash chips \(Puya, UC25HQ80\)/, "it saves on the newer flash chip too");
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

test("resources: the region in the emulated flash at its address, and run --resources boots with it", { skip }, async () => {
  const { chipWith } = await import("../lib/resources.mjs");
  const { crc32 } = await import("node:zlib");
  const pkg = join(P, "app", "build", "e2e.fwsc"), payload = Buffer.alloc(6000, 0x5a), h = Buffer.alloc(32);
  h.writeUInt32LE(0x31534552, 0); h.writeUInt32LE(payload.length, 4); h.writeUInt32LE(crc32(payload) >>> 0, 8); h.writeUInt32LE(crc32(h.subarray(0, 28)) >>> 0, 28);
  const file = join(T, "e2e-res.bin"); writeFileSync(file, Buffer.concat([h, payload]));
  const chip = readFileSync(await chipWith(pkg, { file, base: 0xf2000 }));
  assert.equal(chip.length, 0x100000);
  assert.ok(chip.subarray(0xf2000, 0xf2000 + 6032).equals(Buffer.concat([h, payload])), "the region at its address");
  const r = lab("run", pkg, "--resources", `${file}@0xF2000`);
  assert.equal(r.code, 0, r.out);
  assert.equal(lab("run", pkg, "--resources", `${file}@0xF2010`).code, 64, "not a sector: refused before running");
});

test("map: the template writes only where it may", { skip }, () => {
  const r = lab("map", join(P, "app", "build", "e2e.fwsc"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^OK /m); assert.doesNotMatch(r.out, /ERROR/);
});

test("new --lib: a library as app/lib/NAME, wired into fm1.toml, its tests run by test", { skip }, () => {
  const lib = join(T, "tinylib");
  const sh = (cmd, cwd) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  for (const d of ["include/tiny", "src", "tests"]) spawnSync("mkdir", ["-p", join(lib, d)]);
  writeFileSync(join(lib, "include", "tiny", "tiny.h"), "int tiny_twice(int x);\n");
  writeFileSync(join(lib, "src", "tiny.c"), '#include "tiny/tiny.h"\nint tiny_twice(int x) { return 2 * x; }\n');
  writeFileSync(join(lib, "tests", "run.sh"), "#!/bin/sh\necho \"FASTMATH=$FASTMATH\"\ntest -f \"$FASTMATH/fastmath.h\" && echo '1 passed, 0 failed'\n");
  const g = "git -c user.name=e2e -c user.email=e2e@example.invalid";
  assert.equal(sh(`git init -q -b main && ${g} add -A && ${g} commit -q -m tiny`, lib).status, 0);
  const r = lab("new", "libby", "--dir", T, "--lib", lib, "--no-build", "--git-name", "e2e", "--git-email", "e2e@example.invalid");
  assert.equal(r.code, 0, r.out);
  const proj = join(T, "libby"), toml = readFileSync(join(proj, "app", "fm1.toml"), "utf8");
  assert.match(toml, /^include = \["lib\/tinylib\/include"\]/m);
  assert.match(toml, /^o2 = \["lib\/tinylib\/src\/\*\.c"\]/m);
  const labj = JSON.parse(readFileSync(join(proj, "fm1lab.json"), "utf8"));
  assert.deepEqual(labj.tests, ["app/lib/tinylib/tests/run.sh"]);
  assert.equal(labj.libs[0].name, "tinylib");
  assert.ok(existsSync(join(proj, "app", "lib", "tinylib", "src", "tiny.c")), "the submodule checked out");
  const t = lab("test", proj);
  assert.equal(t.code, 0, t.out);
  assert.match(t.out, /PASS {2}app\/lib\/tinylib\/tests\/run\.sh · 1 checks/, "the library's tests, with fm1-base's fastmath.h");
  assert.equal(lab("build", proj).code, 0, "the library compiles into the firmware");
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
  assert.ok(second.lines.some((l) => /^flash +ok on both chips/.test(l)), "both flash chips every round");
  assert.ok(second.lines.some((l) => /^map +(writes|no flash writes)/.test(l)) && !second.lines.some((l) => /^map +ERROR/.test(l)), "where it writes, every round");
});

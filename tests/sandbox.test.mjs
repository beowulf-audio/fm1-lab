// The sandbox (lib/sandbox.mjs) on this system: what a sandboxed program can't do, and what it can. macOS
// (sandbox-exec) and Linux (bubblewrap). node --test tests/sandbox.test.mjs (part of npm test)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { wrap, sandboxKind } from "../lib/sandbox.mjs";

const LAB = fileURLToPath(new URL("..", import.meta.url));
const kind = sandboxKind();
const skip = kind === "sandbox-exec" || kind === "bwrap" ? false : `no sandbox here (${kind})`;
let work, secret, outside;
const sh = (script) => { const w = wrap(work, [], "/bin/sh", ["-c", script]); return spawnSync(w.cmd, w.args, { encoding: "utf8", timeout: 30000 }); };

before(() => {
  work = mkdtempSync(join(tmpdir(), "fm1-lab-sb-"));
  // a "secret" in the home folder, and a directory beside the work directory
  secret = join(homedir(), `.fm1-lab-sandbox-test-${process.pid}`);
  writeFileSync(secret, "not for the sandbox\n");
  // (not in the system's temp: on macOS that stays writable for compilers; Linux gets a private /tmp)
  mkdirSync(join(LAB, ".work"), { recursive: true });
  outside = mkdtempSync(join(LAB, ".work", "sb-outside-"));
});
after(() => { rmSync(work, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(secret, { force: true }); });

test("writes: inside the work directory only", { skip }, () => {
  assert.equal(sh(`echo ok > "${work}/f"`).status, 0);
  assert.notEqual(sh(`echo x > "${outside}/f"`).status, 0, "beside the work directory");
  assert.equal(existsSync(join(outside, "f")), false);
  assert.notEqual(sh(`echo x > "${homedir()}/.fm1-lab-escape-${process.pid}"`).status, 0, "the home folder");
  assert.equal(existsSync(join(homedir(), `.fm1-lab-escape-${process.pid}`)), false);
});

test("reads: nothing in the home folder but fm1-lab and the work directory", { skip }, () => {
  assert.notEqual(sh(`cat "${secret}"`).status, 0, "a file in the home folder");
  assert.doesNotMatch(sh(`cat "${secret}" 2>/dev/null`).stdout, /not for the sandbox/);
  assert.equal(sh(`cat "${join(LAB, "README.md")}" > /dev/null`).status, 0, "fm1-lab itself");
  assert.equal(sh(`cat /etc/hosts > /dev/null`).status, 0, "the system");
});

test("network: none", { skip }, () => {
  const r = sh("curl -sS -m 5 -o /dev/null https://example.com");
  assert.notEqual(r.status, 0, "the internet");
  assert.notEqual(sh("curl -sS -m 3 -o /dev/null http://127.0.0.1:9/").status === 0, true, "localhost");
});

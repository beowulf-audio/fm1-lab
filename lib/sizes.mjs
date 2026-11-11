// sizes.mjs — how much of the FM-1 a build uses, and how that changes from build to build.
// Every package: the app's bytes and its slot (FM-1 Inspect's decoder). fm1-base builds also write sizes.json beside
// the ELF: flash, RAM (.data + .bss), the pool, RAM code, the app slot. Each project's history of builds is kept in
// .work/history/ so a build can say what it added.
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "./emu.mjs";

/** sizes.json beside a package, if its build wrote one. */
export function buildSizes(fwscPath) {
  const f = join(dirname(fwscPath), "sizes.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
}

const histFile = (project, rel) => join(ROOT, ".work", "history", createHash("sha1").update(`${project}\0${rel}`).digest("hex").slice(0, 16) + ".jsonl");

/** The previous build's record for this project's package, then this one appended. */
export function recordBuild(project, rel, rec) {
  const f = histFile(project, rel);
  mkdirSync(dirname(f), { recursive: true });
  let prev = null;
  if (existsSync(f)) { const lines = readFileSync(f, "utf8").trim().split("\n").filter(Boolean); if (lines.length) prev = JSON.parse(lines[lines.length - 1]); }
  appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), project, rel, ...rec }) + "\n");
  return prev;
}

const n = (x) => x.toLocaleString("en");
const delta = (a, b) => (a == null || b == null || a === b ? "" : ` (${b > a ? "+" : ""}${n(b - a)})`);

/** One line: "app 139,280 B of 581,564 (24%) · RAM 40,248 · pool 69,384 · RAM code 4,964", with changes since `prev`. */
export function describeSizes(cur, prev = null) {
  const s = cur.sizes, p = prev?.sizes;
  const parts = [`app ${n(cur.appBytes)} B of ${n(cur.appSlot)} (${Math.round((cur.appBytes / Math.max(1, cur.appSlot)) * 100)}%)${delta(prev?.appBytes, cur.appBytes)}`];
  if (s) {
    if (s.ram != null) parts.push(`RAM ${n(s.ram)}${delta(p?.ram, s.ram)}`);
    if (s.pool != null) parts.push(`pool ${n(s.pool)}${delta(p?.pool, s.pool)}`);
    if (s.ramtext != null) parts.push(`RAM code ${n(s.ramtext)}${delta(p?.ramtext, s.ramtext)}`);
  }
  const line = parts.join(" · ");
  return line + (/\([+-]/.test(line) ? "  (changes since the last build)" : "");
}

// check.mjs — is a file a well-formed FM-1 firmware package, and what does FM-1 Inspect's static analysis say about
// it? Used before running a firmware and after building one. The decoder and analysis are FM-1 Inspect's own
// (lib/inspect/, synced unmodified by tools/sync-inspect.sh).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parsePackage } from "./inspect/fwsc.js";
import { analyze } from "./inspect/analyze.js";

/** @returns {{file:string, ok:boolean, errors:string[], identity:string, model:string|null, chipKey:string|null,
 *            appBytes:number, appSlot:number, verdict:string, findings:Array}} */
export function checkPackage(path) {
  const bytes = new Uint8Array(readFileSync(path));
  const pkg = parsePackage(bytes);
  const out = {
    file: basename(path), bytes: bytes.length, ok: pkg.ok, errors: pkg.errors, identity: pkg.identity,
    chipKey: pkg.chipKey == null ? null : `0x${pkg.chipKey.toString(16).toUpperCase()}`,
    appBytes: pkg.app ? pkg.app.length : 0, appSlot: pkg.appSlotSize, model: null, verdict: "invalid", findings: [],
  };
  if (!pkg.ok) return out;
  const { report } = analyze(bytes);
  out.model = report.model ?? null;
  out.verdict = report.verdict;
  out.findings = report.findings.map((f) => ({ level: f.level, area: f.area, text: f.text }));
  return out;
}

/** One line for a terminal. */
export function describe(c) {
  if (!c.ok) return `NOT A VALID PACKAGE: ${c.errors.join(" ")}`;
  const fill = c.appSlot ? ` (${Math.round((c.appBytes / c.appSlot) * 100)}% of its slot)` : "";
  return `${c.identity} · ${c.model} · chip key ${c.chipKey} · app ${c.appBytes.toLocaleString("en")} B${fill} · Inspect: ${c.verdict}`;
}

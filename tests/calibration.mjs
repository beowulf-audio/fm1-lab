#!/usr/bin/env node
// Calibration: the brick test must agree with what is known about these firmwares.
//   node tests/calibration.mjs DIR    (DIR holds the .fwsc files below; missing ones are skipped)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { brickTest } from "../lib/brick.mjs";

const EXPECT = {
  "felucca-1.7.0.fwsc": "fail",         // Felucca recognised the UC25HQ80 only from 1.8.2-beta (fixes #320)
  "felucca-1.8.2-beta.fwsc": "pass",
  "sloop-2.8.5.fwsc": "pass",
  "dinghy-0.4.fwsc": "fail",            // Dinghy's notes: before 0.5, saves were RAM-only on the UC25HQ80
  "dinghy-0.5.fwsc": "pass",
  "FM-1_V15.fwsc": "pass",              // M-VAVE's own firmware runs on every unit
  "FM-1_V16.fwsc": "pass",
};
const dir = process.argv[2];
if (!dir) { console.error("usage: calibration.mjs DIR"); process.exit(64); }
let ok = 0, bad = 0, skipped = 0;
for (const [f, want] of Object.entries(EXPECT)) {
  const p = join(dir, f);
  if (!existsSync(p)) { skipped++; continue; }
  const r = await brickTest(p);
  const good = r.verdict === want;
  good ? ok++ : bad++;
  console.log(`${good ? "ok  " : "BAD "} ${f.padEnd(26)} expected ${want.padEnd(4)} got ${r.verdict}`);
}
console.log(`${ok} agree, ${bad} disagree, ${skipped} skipped`);
process.exitCode = bad ? 1 : 0;

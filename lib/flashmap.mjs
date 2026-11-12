// flashmap.mjs — where a firmware writes its flash, checked against the FM-1's flash contract.
//
// The firmware runs in the emulator through input that makes it save (by default brick-test's: two octave presses,
// then time for an autosave; or a scenario), every erase and page program is taken from the flash trace, and each is
// checked against what the board needs left alone:
//   - the boot head (SPL, the chip key), the RF calibration (stock VM 0xE8000: Bluetooth reads it), key_mac (the last
//     sector): never written, by anything but a bootloader;
//   - the app area: only an installer writes it (a running firmware that writes there is overwriting itself, or a
//     bug); the update loader's staging (0xE0000..0xE4FFF): an install erases it;
//   - the loader's update-record scan: it clears any sector below 0xFC000 whose last 256 bytes look like an update
//     record ("AT" at 0xF06), so a firmware's data there is lost on the next install (fm1-base plat.h, felucca-bsp
//     docs/FLASH.md); checked in the flash as the run leaves it;
//   - places other firmwares and the stock firmware use (BTIF, USR, V16's longer app, known resource regions and
//     stores): not errors, but data there meets another firmware's when a unit switches between them.
// Only what the run wrote is seen: a save the input never triggers isn't checked. Sources: FIRMWARE-KNOWLEDGE.md
// section 4 (ChoralRoot docs/FLASH.md and BOOT-SAFETY.md, m-bootloader docs/SPEC.md, Optimist docs/MEMORY-MAP.md).
import { exec } from "./emu.mjs";

export const SECTOR = 0x1000, FLASH_SIZE = 0x100000;
export const TAIL_TOP = 0xfc000;                      // the loader scans sector tails below this

/** [lo, hi, level, what] — error: never; warn: someone's data or an area an install erases; info: shared with others */
export const AREAS = [
  [0x00000, 0x04000, "error", "the boot head (SPL and the chip key): only a bootloader writes it"],
  [0x04000, 0x93000, "error", "the app area: only an installer writes it (the firmware would overwrite its own code)"],
  [0xe0000, 0xe5000, "warn", "the update loader's staging (0xE0000..0xE4FFF): every install erases it (fm1-base keeps only its crash log here)"],
  [0xe8000, 0xe9000, "error", "the radio's factory calibration (stock VM 0xE8000): Bluetooth reads it and nothing restores it"],
  [0xe9000, 0xea000, "warn", "BTIF, the stock firmware's Bluetooth pairing"],
  [0xea000, 0xfc000, "warn", "USR, the stock patch bank: returning to stock then needs a full reflash"],
  [0xff000, 0x100000, "error", "key_mac (the Bluetooth address): never written"],
];

/** Other firmwares' data: [lo, hi, who] (FIRMWARE-KNOWLEDGE.md 4.3). Shared addresses are normal; this says with whom. */
export const KNOWN = [
  [0x93000, 0xa9000, "the stock V16 app (its app area runs to 0xA9000: installing V16 overwrites this)"],
  [0x93000, 0x9f000, "ChoralRoot's fonts (CRES region, 0x93000..0x9EFFF)"],
  [0x93000, 0x9d000, "Melodee's Prophet banks"],
  [0x93000, 0x97000, "fm1-base XDATA0 (LOOM-8's samples)"],
  [0x97000, 0xe0000, "fm1-base's and Felucca's data area (stores and pools: Polly, LOOM-8, Felucca projects)"],
  [0xa0000, 0xc8000, "Melodee's project pool"],
  [0xab000, 0xc1000, "Polly's and LOOM-8's resource regions (RES1 at 0xAB000)"],
  [0xcb000, 0xe0000, "Melodee's resource region (MRS1 at 0xCB000)"],
  [0xdc000, 0xe0000, "fm1-base's panel and Bluetooth objects, Polly, LOOM-8, Felucca presets, ChoralRoot 0.40's presets"],
  [0xfc000, 0xff000, "settings of almost every firmware (Felucca family, fm1-base, Melodee, ChoralRoot)"],
];

/** The flash trace's writes: [{op, lo, hi}] (an erase its whole block; a page program the bytes it wrote) */
export function writesOf(log) {
  const out = [];
  for (const m of log.matchAll(/^flash cmd ([0-9a-f]{2}) addr ([0-9a-f]{6})(?: bytes (\d+))?/gm)) {
    const cmd = m[1], a = parseInt(m[2], 16), n = m[3] ? Number(m[3]) : 0;
    if (cmd === "20") out.push({ op: "erase", lo: a & ~0xfff, hi: (a & ~0xfff) + 0x1000 });
    else if (cmd === "52") out.push({ op: "erase", lo: a & ~0x7fff, hi: (a & ~0x7fff) + 0x8000 });
    else if (cmd === "d8") out.push({ op: "erase", lo: a & ~0xffff, hi: (a & ~0xffff) + 0x10000 });
    else if (cmd === "60" || cmd === "c7") out.push({ op: "erase", lo: 0, hi: FLASH_SIZE });
    else if (cmd === "02") out.push({ op: "program", lo: a, hi: a + Math.max(1, n - 4) });   // bytes: command + address + data
  }
  return out;
}

const hex = (n) => `0x${n.toString(16).toUpperCase().padStart(5, "0")}`;
const overlap = (a, b, lo, hi) => a < hi && b > lo;

/** Sectors written, as ranges: [{lo, hi, erases, programs}] */
export function ranges(writes) {
  const sec = new Map();
  for (const w of writes) for (let s = w.lo & ~0xfff; s < w.hi; s += SECTOR) {
    const e = sec.get(s) || { erases: 0, programs: 0 };
    e[w.op === "erase" ? "erases" : "programs"]++; sec.set(s, e);
  }
  const out = [];
  for (const s of [...sec.keys()].sort((a, b) => a - b)) {
    const last = out[out.length - 1], e = sec.get(s);
    if (last && last.hi === s) { last.hi = s + SECTOR; last.erases += e.erases; last.programs += e.programs; }
    else out.push({ lo: s, hi: s + SECTOR, ...e });
  }
  return out;
}

/** The findings for a run's writes and the flash it left: [{level, text}] */
export function check(writes, image) {
  const f = [], rs = ranges(writes);
  for (const [lo, hi, level, what] of AREAS) {
    const hit = rs.filter((r) => overlap(r.lo, r.hi, lo, hi));
    if (hit.length) f.push({ level, text: `writes ${hit.map((r) => `${hex(Math.max(r.lo, lo))}..${hex(Math.min(r.hi, hi) - 1)}`).join(", ")}: ${what}` });
  }
  // the loader's tail scan: sectors this run wrote, below 0xFC000, in the flash as left
  if (image) for (const r of rs) for (let s = r.lo; s < Math.min(r.hi, TAIL_TOP); s += SECTOR) {
    if (s < 0x93000 || s + SECTOR > image.length) continue;
    const t = image.subarray(s + 0xf00, s + 0xf08);
    if (t[6] === 0x41 && t[7] === 0x54) f.push({ level: "error", text: `sector ${hex(s)} has "AT" at 0xF06: the update loader takes it for an update record and erases it on the next install` });
    else if (t.some((b) => b !== 0xff)) f.push({ level: "warn", text: `sector ${hex(s)} has data in bytes 0xF00..0xF07, where the update loader looks for update records (keep them erased)` });
  }
  for (const [lo, hi, who] of KNOWN) {
    const hit = rs.filter((r) => overlap(r.lo, r.hi, lo, hi));
    if (hit.length) f.push({ level: "info", text: `${hit.map((r) => `${hex(Math.max(r.lo, lo))}..${hex(Math.min(r.hi, hi) - 1)}`).join(", ")} is also used by ${who}` });
  }
  return f;
}

/** Run the firmware and check where it writes: {code, writes, ranges, findings, ok} */
export async function flashMap(fwsc, { ms = 8000, keys, jedec } = {}) {
  const r = await exec(fwsc, { ms, keys, jedec, flashOut: true });
  const writes = writesOf(r.log), image = r.flashImage ? Buffer.from(r.flashImage) : null;
  const findings = check(writes, image);
  return { code: r.code, writes: writes.length, ranges: ranges(writes), findings, ok: r.code === 0 && !findings.some((x) => x.level === "error") };
}

/** The report as text lines */
export function describe(m) {
  const L = [];
  if (!m.ranges.length) L.push("no flash writes during the run (nothing to check: give it input that saves)");
  else {
    L.push(`writes (${m.writes} operations):`);
    for (const r of m.ranges) L.push(`  ${hex(r.lo)}..${hex(r.hi - 1)}  ${(r.hi - r.lo) / SECTOR} sector${r.hi - r.lo > SECTOR ? "s" : ""}, ${r.erases} erases, ${r.programs} page programs`);
  }
  for (const x of m.findings) L.push(`${x.level === "error" ? "ERROR" : x.level === "warn" ? "warn " : "info "} ${x.text}`);
  return L;
}

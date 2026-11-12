// resources.mjs — a firmware's resource region: data it keeps outside its package, in sectors of the flash's data area
// it chooses, that its installer writes after the update (fm1-base's NAME-res.bin, device/res.c; Melodee's res.bin,
// firmware/src/res.c). Without it the firmware starts as an FM-1 where that second step never ran (Polly: "STYLES
// MISSING", Melodee: its factory sounds missing). The region's address is the app's own (fm1-base: app.h APP_RES_BASE)
// and is in no release file, so it is given with the file: FILE@0xADDR.
//
// Or the region is in the package itself, an entry of its own beside flash.bin that only the firmware's own installer
// writes (ChoralRoot 0.40's res2.bin, type 200, to 0xDC000: its loader's LDR_RES2_LO): entry:TYPE@0xADDR. The emulator
// lays out flash.bin alone, so without it the firmware starts as it would after an install by another updater.
//
// The emulator's --flash file is the whole chip, restored after the package is laid out and saved back at the end; so a
// first boot leaves the chip as the package does, the region goes in at its address, and the run boots from that chip.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { exec } from "./emu.mjs";

export const FLASH_SIZE = 0x100000;                   // the FM-1's 1 MiB chip
const HEAD = 32, SECTOR = 0x1000;
const MAGICS = { 0x31534552: "RES1 (fm1-base)", 0x3153524d: "MRS1 (Melodee)" };
// ChoralRoot's (firmware/src/cr_res.h cr_res_hdr_t): a 64-byte header, the data's length +8 and CRC-32 +12, its own CRC-32
// over the first 60 bytes at +60, the data from +0x40
const CR_HEAD = 64, CR_MAGICS = { 0x53455243: "CRES (ChoralRoot)", 0x32455243: "CRE2 (ChoralRoot's second)" };
const LOW = 0x40000, HIGH = 0xff000;                  // never the boot head and app, nor key_mac (the chip's last sector)

/** "FILE@0xADDR" -> {file, base}; "entry:TYPE@0xADDR" -> {entry, base} (the package's own entry of that type) */
export function parseSpec(spec) {
  const m = /^(.+)@(0x[0-9a-f]+)$/i.exec(String(spec || ""));
  if (!m) throw new Error(`resources: FILE@0xADDR or entry:TYPE@0xADDR (the region's flash address, from the app's source), not "${spec}"`);
  const e = /^entry:(\d+)$/.exec(m[1]);
  return e ? { entry: +e[1], base: parseInt(m[2], 16) } : { file: m[1], base: parseInt(m[2], 16) };
}

const unmask = (b, key) => { for (let i = 0; i < b.length; i++) { b[i] ^= key & 0xff; key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff; } };
/** A package's entry of a type (flash.bin is 0, ota.bin 100), as fm1-soc's fwsc.rs raw_flash_n reads the header: the
 *  masked header blocks (a marker byte after each 0x2F), then 0x50-byte entries (type +0, offset +8, length +12) */
export function packageEntry(fwsc, type) {
  const file = readFileSync(fwsc);
  let n = 0;
  while (n * 0x30 + 0x2f < file.length && (n < 20 || file[n * 0x30 + 0x2f] === 0x7d)) n++;
  if (n < 20) throw new Error("resources: not an FM-1 package");
  const hdr = Buffer.alloc(n * 0x2f);
  for (let i = 0; i < n; i++) file.copy(hdr, i * 0x2f, i * 0x30, i * 0x30 + 0x2f);
  unmask(hdr.subarray(0, 0x40), 0xffff);
  const stream = Buffer.concat([hdr, file.subarray(n * 0x30)]);
  for (let k = 0; k < hdr.readUInt16LE(8) && 0x90 + k * 0x50 <= hdr.length; k++) {
    const e = Buffer.from(stream.subarray(0x40 + k * 0x50, 0x90 + k * 0x50));
    unmask(e, 0xffff);
    if (e.readUInt16LE(0) !== type) continue;
    const off = e.readUInt32LE(8), len = e.readUInt32LE(12);
    if (off + len > stream.length) throw new Error(`resources: the package's entry ${type} is cut short`);
    return Buffer.from(stream.subarray(off, off + len));
  }
  throw new Error(`resources: the package has no entry of type ${type}`);
}

/** The region's bytes: the file, or the package's entry */
export const regionOf = (res, fwsc) => (res.entry != null ? packageEntry(fwsc, res.entry) : readFileSync(res.file));

/** Checked where it goes -> {region, length}: the bytes to write (a package's entry whole, as its installer writes it) */
export function prepare(res, fwsc) {
  const region = regionOf(res, fwsc), { length } = checkRegion(region), n = res.entry != null ? region.length : length;
  checkBase(res.base, n);
  return { region, length: n };
}

/** A resource file's header checked (magic, the payload's length and CRC-32, the header's CRC-32) -> {kind, length} */
export function checkRegion(buf) {
  if (buf.length < HEAD) throw new Error("resources: too short for a resource region");
  const magic = buf.readUInt32LE(0);
  if (CR_MAGICS[magic]) {
    const len = buf.readUInt32LE(8), crc = buf.readUInt32LE(12);
    if (buf.length < CR_HEAD || (crc32(buf.subarray(0, 60)) >>> 0) !== buf.readUInt32LE(60)) throw new Error("resources: its header's CRC-32 is wrong");
    if (buf.length < CR_HEAD + len || (crc32(buf.subarray(CR_HEAD, CR_HEAD + len)) >>> 0) !== crc) throw new Error("resources: cut short or damaged (the data's CRC-32)");
    return { kind: CR_MAGICS[magic], length: CR_HEAD + len };
  }
  const len = buf.readUInt32LE(4), crc = buf.readUInt32LE(8);
  if (!MAGICS[magic]) throw new Error("resources: not a resource region (no RES1, MRS1, CRES or CRE2 header)");
  if ((crc32(buf.subarray(0, 28)) >>> 0) !== buf.readUInt32LE(28)) throw new Error("resources: its header's CRC-32 is wrong");
  if (buf.length < HEAD + len || (crc32(buf.subarray(HEAD, HEAD + len)) >>> 0) !== crc) throw new Error("resources: cut short or damaged (the payload's CRC-32)");
  return { kind: MAGICS[magic], length: HEAD + len };
}

/** The region where it may go: whole sectors of the data area, inside the chip */
export function checkBase(base, length) {
  if (base % SECTOR) throw new Error(`resources: 0x${base.toString(16)} is not the start of a 4 KiB sector`);
  if (base < LOW || base + length > HIGH) throw new Error(`resources: 0x${base.toString(16)}..0x${(base + length).toString(16)} is outside the flash's data area`);
}

/** What a preview was made with: "0xADDR:SHA-256 (16)" of the file; "0xADDR:entryTYPE" (the package's: its own hash
 *  already names it) */
export const resourcesId = ({ file, entry, base }) =>
  `0x${base.toString(16)}:${entry != null ? `entry${entry}` : createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)}`;

const chips = new Map(), dirs = [];
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
/** A chip image with the region in place (a file; one per firmware, region and flash chip in this process) */
export async function chipWith(fwsc, res, o = {}) {
  const key = `${fwsc} ${resourcesId(res)} ${o.jedec || ""}`;
  if (!chips.has(key)) chips.set(key, (async () => {
    const { region, length } = prepare(res, fwsc);
    const first = await exec(fwsc, { ms: 3000, flashOut: true, jedec: o.jedec, sandbox: o.sandbox });
    if (!first.flashImage || first.flashImage.length !== FLASH_SIZE) throw new Error("resources: the emulator returned no flash image");
    const chip = Buffer.from(first.flashImage);
    region.copy(chip, res.base, 0, length);
    const d = mkdtempSync(join(tmpdir(), "fm1-lab-res-")), p = join(d, "chip.bin");
    dirs.push(d);
    writeFileSync(p, chip);
    return p;
  })());
  return chips.get(key);
}

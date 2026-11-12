// resources.mjs — a firmware's resource region: data it keeps outside its package, in sectors of the flash's data area
// it chooses, that its installer writes after the update (fm1-base's NAME-res.bin, device/res.c; Melodee's res.bin,
// firmware/src/res.c). Without it the firmware starts as an FM-1 where that second step never ran (Polly: "STYLES
// MISSING", Melodee: its factory sounds missing). The region's address is the app's own (fm1-base: app.h APP_RES_BASE)
// and is in no release file, so it is given with the file: FILE@0xADDR.
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
const LOW = 0x40000, HIGH = 0xff000;                  // never the boot head and app, nor key_mac (the chip's last sector)

/** "FILE@0xADDR" -> {file, base} */
export function parseSpec(spec) {
  const m = /^(.+)@(0x[0-9a-f]+)$/i.exec(String(spec || ""));
  if (!m) throw new Error(`resources: FILE@0xADDR (the region's flash address, from the app's source), not "${spec}"`);
  return { file: m[1], base: parseInt(m[2], 16) };
}

/** A resource file's header checked (magic, the payload's length and CRC-32, the header's CRC-32) -> {kind, length} */
export function checkRegion(buf) {
  if (buf.length < HEAD) throw new Error("resources: too short for a resource region");
  const magic = buf.readUInt32LE(0), len = buf.readUInt32LE(4), crc = buf.readUInt32LE(8);
  if (!MAGICS[magic]) throw new Error("resources: not a resource region (no RES1 or MRS1 header)");
  if ((crc32(buf.subarray(0, 28)) >>> 0) !== buf.readUInt32LE(28)) throw new Error("resources: its header's CRC-32 is wrong");
  if (buf.length < HEAD + len || (crc32(buf.subarray(HEAD, HEAD + len)) >>> 0) !== crc) throw new Error("resources: cut short or damaged (the payload's CRC-32)");
  return { kind: MAGICS[magic], length: HEAD + len };
}

/** The region where it may go: whole sectors of the data area, inside the chip */
export function checkBase(base, length) {
  if (base % SECTOR) throw new Error(`resources: 0x${base.toString(16)} is not the start of a 4 KiB sector`);
  if (base < LOW || base + length > HIGH) throw new Error(`resources: 0x${base.toString(16)}..0x${(base + length).toString(16)} is outside the flash's data area`);
}

/** What a preview was made with: "0xADDR:SHA-256 (16)" */
export const resourcesId = ({ file, base }) => `0x${base.toString(16)}:${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)}`;

const chips = new Map(), dirs = [];
process.on("exit", () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
/** A chip image with the region in place (a file; one per firmware, region and flash chip in this process) */
export async function chipWith(fwsc, res, o = {}) {
  const key = `${fwsc} ${resourcesId(res)} ${o.jedec || ""}`;
  if (!chips.has(key)) chips.set(key, (async () => {
    const region = readFileSync(res.file), { length } = checkRegion(region);
    checkBase(res.base, length);
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

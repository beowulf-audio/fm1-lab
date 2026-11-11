// fwsc.js — read an M-VAVE FM-1 / SMK-37 update package (.fwsc) entirely in memory.
// Works in the browser and in Node (ES module, no dependencies, no I/O).
//
// Format (JieLi UFW + JLFS, as the FM-1 updaters use it). Written from the format notes in
// fm1-emu's web/fwsc.js (Joakim Eriksson, MIT) and Felucca's tools/fm1_install.py description:
//   * The file is split into blocks of 0x30 bytes. The first 0x2F bytes of each of the first 20
//     blocks, concatenated, form the UFW header; the 20 leftover bytes carry the package identity
//     ("FM-1_906"): char = (byte - i - 1) & 0xFF, 0x7D meaning "no character".
//   * Header parts are XOR-masked with a CRC-16/CCITT keystream starting at 0xFFFF.
//     0x40-byte header (CRC16 of bytes 2..0x3F at offset 0, entry count at 8),
//     then 0x50 bytes per entry (type +0, offset +8, size +12). Type 0 is the flash image.
//   * The flash image is a JLFS directory of 32-byte heads, each masked on its own
//     (offset +4, size +8, flags +12, last +14, name +16). isd_config.ini carries the chip key;
//     app_dir_head (flags 0x81) starts the app area, which is masked per 32 bytes with
//     (chip key XOR position/4). Inside it, app.bin (flags 0x82) is the code the chip runs.

const BLK = 0x30, KEEP = 0x2f, BLOCKS = 20;

function unmask(buf, off, len, key = 0xffff) {
  for (let i = 0; i < len; i++) {
    buf[off + i] ^= key & 0xff;
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
}

function crc16(buf, off, len) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= buf[off + i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function cstr(b, o, n) {
  let s = "";
  for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
  return s;
}
const head = (b, o) => ({ offset: u32(b, o + 4), size: u32(b, o + 8), flags: b[o + 12], last: u16(b, o + 14), name: cstr(b, o + 16, 16) });

function chipKey(blob) {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += blob[i];
  sum &= 0xff;
  if (sum >= 0xe0) sum = 0xaa;
  else if (sum <= 0x10) sum = 0x55;
  let key = 0;
  for (let i = 0; i < 16; i++) if ((blob[16 + i] ^ blob[15 - i]) < sum) key |= 1 << i;
  return key;
}

function unscramble(buf, from, len, base, key) {
  for (let i = 0; i < len; i += 32) unmask(buf, from + i, Math.min(32, len - i), key ^ ((from + i - base) >> 2));
}

/** The package identity string, e.g. "FM-1_906" (or "" if absent). */
export function identityOf(file) {
  let s = "";
  for (let i = 0; i < BLOCKS && i * BLK + KEEP < file.length; i++) {
    const m = file[i * BLK + KEEP];
    if (m !== 0x7d) s += String.fromCharCode((m - i - 1) & 0xff);
  }
  return s;
}

/**
 * Parse a package. Never throws: problems are reported in `errors`, and as much as could be read is returned.
 * @param {Uint8Array} file
 * @returns {{ok:boolean, errors:string[], identity:string, headerCrcOk:boolean, entries:Array,
 *            files:Array, chipKey:number|null, appFiles:Array, app:Uint8Array|null, appSlotSize:number}}
 */
export function parsePackage(file) {
  const r = { ok: false, errors: [], identity: "", headerCrcOk: false, entries: [], files: [], chipKey: null, appFiles: [], app: null, appSlotSize: 0 };
  if (!(file instanceof Uint8Array)) file = new Uint8Array(file);
  if (file.length < BLOCKS * BLK) { r.errors.push("File is too short to be an FM-1 package."); return r; }
  r.identity = identityOf(file);

  const hdr = new Uint8Array(BLOCKS * KEEP);
  for (let i = 0; i < BLOCKS; i++) hdr.set(file.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
  unmask(hdr, 0, 0x40);
  r.headerCrcOk = crc16(hdr, 2, 0x3e) === u16(hdr, 0);
  if (!r.headerCrcOk) { r.errors.push("Header checksum is wrong: this is not an FM-1 update package (.fwsc), or it is damaged."); return r; }

  const n = u16(hdr, 8);
  let flash = null;
  for (let k = 0; k < n && 0x90 + k * 0x50 <= hdr.length; k++) {
    const e = hdr.slice(0x40 + k * 0x50, 0x90 + k * 0x50);
    unmask(e, 0, 0x50);
    const ent = { type: u16(e, 0), offset: u32(e, 8), size: u32(e, 12) };
    r.entries.push(ent);
    if (ent.type === 0 && !flash) {
      const at = ent.offset + BLOCKS * (BLK - KEEP);
      if (at + ent.size > file.length) r.errors.push("The flash image runs past the end of the file (truncated download?).");
      flash = file.slice(at, at + ent.size);
    }
  }
  if (!flash) { r.errors.push("No flash image inside the package."); return r; }

  unmask(flash, 0, 32);
  let area = null;
  for (let o = 32; o + 32 <= flash.length; o += 32) {
    unmask(flash, o, 32);
    const h = head(flash, o);
    r.files.push({ name: h.name, offset: h.offset, size: h.size, flags: h.flags });
    if (h.name === "isd_config.ini" && h.offset + 34 <= flash.length && crc16(flash, h.offset, 32) === u16(flash, h.offset + 32))
      r.chipKey = chipKey(flash.subarray(h.offset, h.offset + 32));
    if (h.name === "app_dir_head" && h.flags === 0x81 && area === null) area = h.offset;
    if (h.last) break;
  }
  if (r.chipKey === null) r.errors.push("No chip key (isd_config.ini) found.");
  if (area === null) r.errors.push("No application area (app_dir_head) found: this may be a bootloader or a recovery stage, not a firmware.");
  if (r.chipKey === null || area === null) return r;

  const first = ((area + 32 + 31) & ~31) - area;
  unscramble(flash, area, first, area, r.chipKey);
  const size = head(flash, area).size;
  if (size > first) unscramble(flash, area + first, Math.min(size, flash.length - area) - first, area, r.chipKey);
  for (let o = area + 32; o + 32 <= area + size && o + 32 <= flash.length; o += 32) {
    const h = head(flash, o);
    r.appFiles.push({ name: h.name, size: h.size, flags: h.flags });
    if (h.name === "app.bin" && h.flags === 0x82 && !r.app) {
      let end = h.size;
      const start = area + h.offset;
      end = Math.min(end, flash.length - start);
      r.appSlotSize = h.size;
      while (end > 0 && flash[start + end - 1] === 0xff) end--;
      r.app = flash.slice(start, start + end);
    }
    if (h.last) break;
  }
  if (!r.app) { r.errors.push("No app.bin inside the application area."); return r; }
  r.ok = true;
  return r;
}

// crash.mjs — did a firmware crash during a run, and where? For packages built with an ELF beside them (fm1-base and
// felucca-bsp builds): the BSP's fault handler keeps the crash in .noinit RAM (fm1_crash: chip/fm1_irq.h, magic "CRSH",
// the faulting pc, rets, sp, the time since boot, the last branches; fm1_crash_ctx: the registers), shows its red crash
// screen and waits, so the emulator sees no fault of its own. fm1-lab asks the emulator for the RAM at the end
// (FM1_DUMPRAM), finds the structures in the ELF (llvm-nm), and names each address's function and line
// (llvm-addr2line): both are fm1-lab's own compiler's tools, run in the sandbox.
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "./setup.mjs";
import { wrap } from "./sandbox.mjs";

const RAM_BASE = 0x01c00000, MAGIC = 0x43525348;   // "CRSH"
const CTX_SIZE = 80, CTX_N = 4;

/** The ELF a package was built from, if it is beside it (NAME.elf, or the only .elf there). */
export function elfFor(fwsc) {
  const same = join(dirname(fwsc), basename(fwsc).replace(/(-\d+(\.\d+)*)?\.fwsc$/i, ".elf"));
  return existsSync(same) ? same : null;
}

function tool(name, args, elf) {
  const tc = paths.toolchain(); if (!tc) return "";
  const bin = join(tc, "llvm", "bin", name), work = dirname(elf);
  try { const w = wrap(work, [], bin, args); return execFileSync(w.cmd, w.args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return ""; }
}

export function symbolAddr(elf, names) {
  const out = {};
  for (const l of tool("llvm-nm", [elf], elf).split("\n")) {
    const m = l.match(/^([0-9a-f]+)\s+\w\s+(\S+)$/); if (m && names.includes(m[2])) out[m[2]] = parseInt(m[1], 16);
  }
  return out;
}

/** "function at file:line" for each address. */
export function symbolize(elf, addrs) {
  const valid = addrs.filter((a) => a > 0);
  if (!valid.length) return {};
  const lines = tool("llvm-addr2line", ["-f", "-C", "-e", elf, ...valid.map((a) => `0x${a.toString(16)}`)], elf).split("\n");
  const out = {};
  valid.forEach((a, i) => {
    const fn = lines[2 * i] || "??", loc = (lines[2 * i + 1] || "??:0").replace(/^.*\/(base|app)\//, "$1/");
    // a linker marker (_etext, _end, __bss_end, ...) with no source: past the code, not in a function
    const marker = /^_/.test(fn) && /\?\?/.test(loc);
    out[a] = fn === "??" || marker ? null : `${fn} (${loc.replace(/:0$/, "")})`;
  });
  return out;
}

/** The crash in a RAM dump (the emulator's FM1_DUMPRAM: 1 MiB from 0x01C00000), or null. */
export function readCrash(ram, elf) {
  if (!ram || !elf) return null;
  const at = symbolAddr(elf, ["fm1_crash", "fm1_crash_ctx"]);
  if (at.fm1_crash == null) return null;
  const o = at.fm1_crash - RAM_BASE;
  if (o < 0 || o + 64 > ram.length || ram.readUInt32LE(o) !== MAGIC) return null;
  const w = (i) => ram.readUInt32LE(o + 4 * i);
  const c = { count: w(1), vec: w(2), pc: w(3), rets: w(4), emu: w(5), dbg: w(6), sp: w(7), psr: w(8), uptimeMs: w(10),
              branches: [w(11), w(12), w(13), w(14)].filter(Boolean), early: w(15) };
  if (at.fm1_crash_ctx != null) {   // the registers of this crash (the context whose count matches)
    const b = at.fm1_crash_ctx - RAM_BASE;
    for (let k = 0; k < CTX_N && b + (k + 1) * CTX_SIZE <= ram.length; k++) {
      const p = b + k * CTX_SIZE;
      if (ram.readUInt32LE(p) === c.count && c.count) {
        c.regs = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`r${i}`, ram.readUInt32LE(p + 8 + 4 * i)]));
        c.regs.usp = ram.readUInt32LE(p + 72); c.regs.ssp = ram.readUInt32LE(p + 76);
      }
    }
  }
  const names = symbolize(elf, [c.pc, c.rets, ...c.branches]);
  c.where = { pc: names[c.pc] || null, rets: names[c.rets] || null, branches: c.branches.map((a) => names[a] || null) };
  return c;
}

const hex = (a) => `0x${(a >>> 0).toString(16).padStart(8, "0")}`;
/** One line: "crashed 1.03 s after boot: pc 0x0ead0002 (not code), called from app_frame (app/app.c:309)". */
export function describeCrash(c) {
  const at = (a, n) => (n ? `${hex(a)} in ${n}` : `${hex(a)} (not in the firmware's code)`);
  return `crashed ${(c.uptimeMs / 1000).toFixed(2)} s after boot (crash #${c.count}): pc ${at(c.pc, c.where.pc)}; returning to ${at(c.rets, c.where.rets)}`;
}

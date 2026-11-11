// sandbox.mjs — how fm1-lab runs anything it didn't write (the emulator, compilers, firmware builds, the host
// simulator): no network, writes only inside one directory (and temp), nothing in the home folder readable except
// that directory, fm1-lab and up to two more.
//   macOS: sandbox-exec with lib/sandbox.sb (also denies .env files and the keychains anywhere; the system's temp
//          directories stay writable, as compilers need them)
//   Linux: bubblewrap (bwrap): no network namespace, the filesystem read-only, an empty read-only home with only the
//          allowed directories bound back (read-only), the work directory writable, a private /tmp. (Ubuntu 24.04 restricts
//          unprivileged user namespaces: CI enables them with `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.)
// Neither available: fm1-lab refuses, unless FM1_LAB_SANDBOX=off says the machine is itself disposable (a CI runner).
import { existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { platform, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let bwrapPath;
const findBwrap = () => {
  if (bwrapPath !== undefined) return bwrapPath;
  try { bwrapPath = execFileSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).trim() || null; } catch { bwrapPath = null; }
  return bwrapPath;
};

/** "sandbox-exec", "bwrap", "off" (FM1_LAB_SANDBOX=off) or null (none: fm1-lab won't run third-party code). */
export function sandboxKind() {
  if (process.env.FM1_LAB_SANDBOX === "off") return "off";
  if (platform() === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "sandbox-exec";
  if (platform() === "linux" && findBwrap()) return "bwrap";
  return null;
}
export const sandboxAvailable = () => sandboxKind() !== null;

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/**
 * The command that runs `program args` sandboxed.
 * @param {string} work  the one writable directory (it exists)
 * @param {string[]} extra  more readable directories (up to two)
 * @returns {{cmd:string, args:string[], kind:string}}
 */
export function wrap(work, extra, program, args) {
  const kind = sandboxKind(), w = real(work), reads = [ROOT, ...extra].filter(Boolean).map(real);
  if (kind === "off") return { cmd: program, args, kind };
  if (kind === "sandbox-exec") {
    const r = [...reads, "/nonexistent-1", "/nonexistent-2"];
    return { cmd: "/usr/bin/sandbox-exec", kind, args: ["-f", join(ROOT, "lib", "sandbox.sb"), "-D", `HOME=${homedir()}`, "-D", `WORK=${w}`,
      "-D", `READ1=${r[0]}`, "-D", `READ2=${r[1]}`, program, ...args] };
  }
  if (kind === "bwrap") {
    const home = real(homedir());
    const b = ["--die-with-parent", "--unshare-net", "--unshare-ipc", "--unshare-pid", "--new-session",
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", home];
    for (const d of reads) if (existsSync(d)) b.push("--ro-bind", d, d);   // back into the empty home (or anywhere)
    b.push("--bind", w, w);                                                 // writable even inside a read-only one
    // the empty home read-only too (as on macOS: a write there fails, not just vanishes); the mounts in it keep theirs
    b.push("--remount-ro", home);
    return { cmd: findBwrap(), kind, args: [...b, "--chdir", w, program, ...args] };
  }
  throw new Error(platform() === "linux"
    ? "no sandbox: install bubblewrap (apt install bubblewrap), or set FM1_LAB_SANDBOX=off on a disposable machine (CI)"
    : "no sandbox on this system: fm1-lab runs third-party code only sandboxed (macOS sandbox-exec, Linux bubblewrap)");
}

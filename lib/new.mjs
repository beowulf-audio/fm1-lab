// new.mjs — a new FM-1 firmware project on fm1-base, ready to build, run and compare with fm1-lab.
//
//   NAME/
//     base/               fm1-base as a git submodule, at the commit fm1-lab's builds were reviewed and validated with
//     app/                the app: fm1-base's template (app.c, app.h, fm1.toml, words.tsv, tests, docs, site), renamed
//     scenarios/smoke.yaml  an fm1-lab scenario: boot, a note, a chord, a knob, a screenshot of each
//     build.sh            python3 base/tools/build.py app "$@" (what fm1-base's release workflow calls)
//     fm1lab.json         tells fm1-lab what this is
//
// The app uses fm1-base's own Bluetooth stack (ble_stack = "own"), so nothing of JieLi's SDK is linked and the whole
// firmware builds from source. Its package identity prefix is one no firmware in FM-1 Inspect's index uses.
// git: a new repository with one commit and no remote, committed with the git identity you have configured (or
// --git-name/--git-email for this project only); --gh-credential makes it log in to GitHub through gh (gh auth).
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "./emu.mjs";

// the fm1-base fm1-lab's builds were reviewed with (docs/optimist-review.md, docs/toolchain-review.md)
export const FM1_BASE = {
  url: "https://github.com/w0ts/fm1-base",
  commit: "219721955bd660d94b01f2197536bf9bc4eb1052",
  bsp: { url: "https://github.com/hugelton/felucca-bsp", commit: "8d5fd55ed4d8d4feb9f5acd3765a0d03cf9c8ac5" },
  local: join(ROOT, ".work", "optimist-v0.3", "fm1base"),   // a reviewed checkout, if present (saves the download)
};

// git that can't use an account: no credential helpers, no prompts, no SSH; file:// only for the local checkout
const git = (args, cwd, extra = []) => execFileSync("git", ["-c", "credential.helper=", ...extra, ...args],
  { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "false" } }).toString().trim();

/** Two-digit identity prefixes no firmware in FM-1 Inspect's index uses. */
export async function freePrefixes() {
  let data = null;
  const local = join(ROOT, "..", "fm1-inspect", "site", "data", "known.json");
  if (existsSync(local)) data = JSON.parse(readFileSync(local, "utf8"));
  else {
    const r = await fetch("https://beowulf-audio.github.io/fm1-inspect/data/known.json").catch(() => null);
    if (r?.ok) data = await r.json();
  }
  if (!data) return null;
  const used = new Set(data.entries.map((e) => e.identity).filter((i) => /^FM-1_\d\d/.test(i || "")).map((i) => i.slice(5, 7)));
  return Array.from({ length: 100 }, (_, i) => String(i).padStart(2, "0")).filter((p) => !used.has(p) && p !== "00");
}

/** The project's first commit (after its first build, so the firmware.json fm1-base's build writes is in it). */
export function commitProject(dest, NAME, prefix) {
  git(["add", "-A"], dest);
  git(["commit", "-q", "-m", `${NAME}: new FM-1 firmware from fm1-base's template\n\nfm1-base ${FM1_BASE.commit.slice(0, 7)} (w0ts/fm1-base) as base/, its template as app/,\nidentity prefix ${prefix}, fm1-base's own Bluetooth stack. Made by fm1-lab new.`], dest);
  return git(["rev-parse", "--short", "HEAD"], dest);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * @param {string} name
 * @param {{dir?:string, id?:string, author?:string, gitName?:string, gitEmail?:string, ghCredential?:boolean, commit?:boolean,
 *          onStep?:Function}} o  dir: the parent directory (default: the current one); author: fm1.toml's (default: git's user.name)
 */
export async function newProject(name, o = {}) {
  const step = o.onStep || (() => {});
  const id = slug(name);
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error(`"${name}": a name of 2-31 letters, digits and dashes, starting with a letter`);
  const dest = resolve(o.dir || ".", id);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  const NAME = id.toUpperCase().replace(/-/g, "_");

  let prefix = o.id;
  if (prefix) {
    if (!/^\d{2}$/.test(prefix)) throw new Error(`--id: two digits (the package identity is FM-1_<id>...)`);
  } else {
    const free = await freePrefixes();
    if (!free?.length) throw new Error("couldn't read FM-1 Inspect's index to pick a free identity prefix: give one with --id NN");
    let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    prefix = free[h % free.length];
  }

  step(`repository ${dest}`);
  mkdirSync(dest, { recursive: true });
  try {
    git(["init", "-q", "-b", "main"], dest);
    if (o.gitEmail) git(["config", "user.email", o.gitEmail], dest);
    if (o.gitName) git(["config", "user.name", o.gitName], dest);
    if (o.ghCredential) {   // GitHub logins through gh only (not a keychain's): gh auth status says which account
      git(["config", "--replace-all", "credential.https://github.com.helper", ""], dest);
      git(["config", "--add", "credential.https://github.com.helper", "!gh auth git-credential"], dest);
    }
    const cfg = (k) => { try { return git(["config", "--get", k], dest); } catch { return ""; } };
    if (!cfg("user.email") || !cfg("user.name")) throw new Error("git has no identity to commit with: set one (git config --global user.name / user.email) or pass --git-name and --git-email");
    const author = o.author ?? cfg("user.name");

    // fm1-base as a submodule at the pinned commit, its URL the public HTTPS one
    step(`fm1-base ${FM1_BASE.commit.slice(0, 7)} as base/`);
    const fromLocal = existsSync(join(FM1_BASE.local, ".git")) &&
      (() => { try { git(["cat-file", "-e", `${FM1_BASE.commit}^{commit}`], FM1_BASE.local); return true; } catch { return false; } })();
    const allowFile = ["-c", "protocol.file.allow=always"];
    git(["submodule", "add", "--name", "base", fromLocal ? FM1_BASE.local : FM1_BASE.url, "base"], dest, fromLocal ? allowFile : []);
    const base = join(dest, "base");
    try { git(["cat-file", "-e", `${FM1_BASE.commit}^{commit}`], base); }
    catch { git(["fetch", "-q", "--depth", "1", "origin", FM1_BASE.commit], base, fromLocal ? allowFile : []); }
    git(["checkout", "-q", FM1_BASE.commit], base);
    git(["config", "-f", ".gitmodules", "submodule.base.url", FM1_BASE.url], dest);
    git(["submodule", "sync", "-q"], dest);
    git(["remote", "set-url", "origin", FM1_BASE.url], base);
    // its own submodule, the BSP
    const bspLocal = join(FM1_BASE.local, "bsp");
    const bspFromLocal = fromLocal && existsSync(join(bspLocal, ".git"));
    git(["submodule", "update", "--init", "--depth", "1", "bsp"], base,
      bspFromLocal ? [...allowFile, "-c", `submodule.bsp.url=${bspLocal}`] : ["-c", `url.https://github.com/.insteadOf=git@github.com:`]);
    git(["checkout", "-q", FM1_BASE.bsp.commit], join(base, "bsp"));
    git(["remote", "set-url", "origin", FM1_BASE.bsp.url], join(base, "bsp"));
    git(["config", "submodule.bsp.url", FM1_BASE.bsp.url], base);   // registered, with its public URL
    git(["config", "submodule.bsp.active", "true"], base);
    if (git(["rev-parse", "HEAD"], base) !== FM1_BASE.commit) throw new Error("base/ is not at the pinned commit");

    // the app, from the template
    step("app/ from fm1-base's template");
    const app = join(dest, "app");
    cpSync(join(base, "template"), app, { recursive: true, filter: (p) => !p.includes(`${"/"}.github`) && !p.endsWith("/build") });
    let toml = readFileSync(join(app, "fm1.toml"), "utf8");
    const set = (key, value) => { toml = toml.replace(new RegExp(`^${key}\\s*=.*?(\\s+#.*)?$`, "m"), (m, c) => `${key} = ${JSON.stringify(value)}${c ? c.replace(/^\s+/, "   ") : ""}`); };
    set("name", NAME); set("id_prefix", `FM-1_${prefix}`);
    set("usb_manufacturer", author || NAME); set("usb_product", `${NAME} FM-1`);
    set("tagline", ""); set("repo", ""); set("credits", "Built on fm1-base (MPL-2.0).");
    set("author", author); set("description", ""); set("install", ""); set("site", "");
    set("screenshot", "app/docs/img/screen-playing.png");   // relative to the repository's root
    toml = toml.replace(/^ble_central\s*=.*$/m, (l) => `${l}\nble_stack = "own"             # fm1-base's own Bluetooth stack: nothing of JieLi's SDK linked (fm1-lab new)`);
    if (!/^ble_stack/m.test(toml)) toml += `\nble_stack = "own"\n`;
    if (!/^crash_history/m.test(toml)) toml += `\n# the crash records kept in flash across power-offs, with each stack's room at a crash (fm1-lab new);\n# fm1-lab run reads a crash from the emulator's RAM either way\ncrash_history = true\n`;
    writeFileSync(join(app, "fm1.toml"), `# ${NAME}: made by fm1-lab new from fm1-base's template (${FM1_BASE.commit.slice(0, 7)})\n${toml}`);
    const h = readFileSync(join(app, "app.h"), "utf8").replace(/#define APP_NAME "TEMPLATE"/, `#define APP_NAME "${NAME}"`);
    writeFileSync(join(app, "app.h"), h);
    const words = readFileSync(join(app, "words.tsv"), "utf8").replace(/^# url: .*$/m, `# (fm1-lab new: set the next line to where your site publishes its words; example.com until then)\n# url: https://example.com/${id}/words/`).replace(/^TEMPLATE\ttemplate$/m, `${NAME}\t${id.replace(/-/g, " ")}`);
    writeFileSync(join(app, "words.tsv"), words);
    // the tests: the spoken name is APP_NAME's, and the comments' paths are this layout's
    for (const t of readdirSync(join(app, "tests")).filter((n) => n.endsWith(".txt"))) {
      const f = join(app, "tests", t);
      writeFileSync(f, readFileSync(f, "utf8")
        .replace(/^(said(?:\s+\S+)?\s+)TEMPLATE\b/gm, `$1${NAME}`)
        .replace(/tools\/build\.py template --host, then/g, "fm1-lab test (or: python3 base/tools/build.py app --host, then")
        .replace(/template\/build\/host\/template_host template\/tests\/(\S+) template\/(\S+)/g, "app/build/host/app_host app/tests/$1 app/$2)")
        // the simulator has a Bluetooth MIDI device to find; the emulated device (fm1-lab run) has none
        .replace(/^(# REC: look for Bluetooth MIDI devices.*\n)/m, "# fm1-lab: simulator only (a Bluetooth MIDI device to find: the simulator has one, the emulator none)\n$1")
        .replace(/^(unsaid LOST\n)(# each port's messages counted)/m, "$1# fm1-lab: end\n$2"));
    }

    // fm1-lab's files
    mkdirSync(join(dest, "scenarios"));
    writeFileSync(join(dest, "scenarios", "smoke.yaml"), `# ${NAME} in the emulator: fm1-lab run scenarios/smoke.yaml app/build/${id}.fwsc
name: ${id} smoke
ms: 6000
click_ms: 150
reader: true          # a screen reader on USB: each screenshot's text, and what the app says as things change
steps:
  - { at: 1200, screenshot: boot }
  - { at: 1500, note: C4, vel: 100, hold: 500 }
  - { at: 1800, screenshot: note }
  - { at: 2400, note: C4, vel: 90, hold: 800 }
  - { at: 2400, note: E4, vel: 90, hold: 800 }
  - { at: 2400, note: G4, vel: 90, hold: 800 }
  - { at: 2800, screenshot: chord }
  - { at: 3600, turn: KNOB3, clicks: 3 }
  - { at: 4300, note: A4, vel: 110, hold: 400 }
  - { at: 4600, screenshot: knob }
expect:
  boots: true
  sound: true
  no_clipping: true
  said: "${NAME}"
  midi_out_min: 1     # the keys go out as MIDI over USB
`);
    writeFileSync(join(dest, "build.sh"), `#!/bin/sh\n# The firmware: app/build/${id}.fwsc (fm1-base's build; fm1-lab build . runs it in fm1-lab's sandbox)\nexec python3 base/tools/build.py app "$@"\n`, { mode: 0o755 });
    writeFileSync(join(dest, "fm1lab.json"), JSON.stringify({ kind: "fm1-base", base: "base", app: "app", package: `app/build/${id}.fwsc`, scenario: "scenarios/smoke.yaml" }, null, 2) + "\n");
    writeFileSync(join(dest, ".gitignore"), "app/build/\napp/web/words/\n.DS_Store\n");
    writeFileSync(join(dest, "README.md"), `# ${NAME}

FM-1 firmware on [fm1-base](${FM1_BASE.url}) (MPL-2.0: changes to fm1-base's files stay MPL-2.0; your own files may use any licence).

    fm1-lab build .                                   # app/build/${id}.fwsc, built in fm1-lab's sandbox
    fm1-lab run scenarios/smoke.yaml app/build/${id}.fwsc --html report.html
    fm1-lab compare scenarios/smoke.yaml OLD.fwsc app/build/${id}.fwsc

Write the app in \`app/app.c\` (\`app_render\` for the sound, \`app_frame\` for the screen and the controls) and \`app/app.h\`.
Package identity: \`FM-1_${prefix}\` (\`id_prefix\` in \`app/fm1.toml\`; unused by the firmwares FM-1 Inspect knows).
Before a release build, fill in \`app/fm1.toml\`'s description, tags, tagline, repo, install page, site and screenshot,
and see \`base/template/README.md\` ("Make it your own").
`);

    if (o.commit !== false) commitProject(dest, NAME, `FM-1_${prefix}`);
  } catch (e) {
    throw new Error(`${e.message}${e.stderr ? `\n${e.stderr}` : ""}\n(the half-made project is at ${dest})`);
  }
  return { dir: dest, id, NAME, prefix: `FM-1_${prefix}`, package: join(dest, "app", "build", `${id}.fwsc`), scenario: join(dest, "scenarios", "smoke.yaml") };
}

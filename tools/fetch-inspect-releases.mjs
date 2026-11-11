// FM-1 Inspect's release files (its site/data/releases.json: SHA-256 -> repo, tag, asset) into .work/releases/SHA.fwsc,
// for `fm1-lab sweep --brick`. A file the local corpus already has is copied; the rest are downloaded anonymously
// from their public GitHub release (no login, no token), and each is checked against its SHA-256 before it is kept.
//   node tools/fetch-inspect-releases.mjs [RELEASES.json] [CORPUS_DIR...]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const relFile = process.argv[2] || join(ROOT, "..", "fm1-inspect", "site", "data", "releases.json");
const corpus = process.argv.slice(3).length ? process.argv.slice(3) : [join(ROOT, "..", "examples"), join(ROOT, "..", "tools")];
const OUT = join(ROOT, ".work", "releases");
mkdirSync(OUT, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");

const rel = JSON.parse(readFileSync(relFile, "utf8")).releases;
const want = Object.entries(rel).filter(([s]) => !existsSync(join(OUT, `${s}.fwsc`)));
console.log(`${Object.keys(rel).length} release files in ${relFile}; ${want.length} not here yet`);

// the corpus first
const local = new Map();
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) { if (n !== ".git" && n !== "node_modules") walk(p); } else if (n.endsWith(".fwsc")) local.set(sha(readFileSync(p)), p); } };
for (const d of corpus) if (existsSync(d)) walk(d);
let copied = 0;
for (const [s] of want) if (local.has(s)) { copyFileSync(local.get(s), join(OUT, `${s}.fwsc`)); copied++; }
console.log(`copied ${copied} from the corpus`);

// the rest from GitHub, 6 at a time
const todo = want.filter(([s]) => !existsSync(join(OUT, `${s}.fwsc`)));
let i = 0, ok = 0, bad = [], t0 = Date.now();
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < todo.length) {
    const [s, r] = todo[i++];
    const url = `https://github.com/${r.repo}/releases/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(r.asset)}`;
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "fm1-lab" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const b = Buffer.from(await res.arrayBuffer());
      if (sha(b) !== s) throw new Error("SHA-256 differs from releases.json");
      writeFileSync(join(OUT, `${s}.part`), b); renameSync(join(OUT, `${s}.part`), join(OUT, `${s}.fwsc`)); ok++;
    } catch (e) { bad.push({ sha: s, repo: r.repo, tag: r.tag, asset: r.asset, error: String(e.message || e) }); }
    if ((ok + bad.length) % 100 === 0) console.log(`  ${ok + bad.length}/${todo.length} · ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}));
writeFileSync(join(OUT, "missing.json"), JSON.stringify(bad, null, 1));
console.log(`downloaded ${ok}; ${bad.length} not available (missing.json) · ${Math.round((Date.now() - t0) / 1000)} s`);

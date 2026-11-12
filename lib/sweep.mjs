// sweep.mjs — many firmwares at once: each one checked (FM-1 Inspect's decoder), booted with the smoke scenario
// (screenshots, a short sound preview, crashes when an ELF is beside it) and, with brick, the UC25HQ80 flash test.
// Results are kept per file (by SHA-256) in OUT/results, so a sweep that stops resumes where it was; the same file
// twice is run once. OUT/index.html is the gallery; OUT/results.json and OUT/brick.json (sha -> verdict) the data.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, relative } from "node:path";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { checkPackage } from "./check.mjs";
import { runScenario } from "./run.mjs";
import { parseSpec, resourcesId, checkRegion, checkBase } from "./resources.mjs";
import { SMOKE, loadScenario } from "./scenario.mjs";
import { ROOT } from "./emu.mjs";
import { previewGif, previewAudio, previewStats, tourHash, ffmpeg } from "./preview.mjs";
import { brickTest } from "./brick.mjs";
import { png } from "./image.mjs";
import { toWav } from "./audio.mjs";
import { page, esc } from "./report.mjs";

/** .fwsc files under the given paths (files, directories, or @LIST: one path a line). */
export function collect(paths) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) { for (const n of readdirSync(p)) if (!/^(\.git|node_modules)$/.test(n)) walk(join(p, n)); }
    else if (p.toLowerCase().endsWith(".fwsc")) out.push(resolve(p));
  };
  for (const p of paths) {
    if (p.startsWith("@")) for (const l of readFileSync(p.slice(1), "utf8").split("\n").map((s) => s.trim()).filter(Boolean)) walk(l);
    else walk(p);
  }
  return out;
}

/**
 * @param {string[]} files
 * @param {{out:string, jobs?:number, brick?:boolean, gif?:boolean, m4a?:boolean, tours?:object, audio?:boolean, force?:boolean,
 *          onProgress?:Function}} o  tours: {SHA|"*": {scenario, source, resources?: "FILE@0xADDR"}} (resources: the file's
 *          resource region, in place for its preview: lib/resources.mjs)
 */
export async function sweep(files, o) {
  const out = resolve(o.out);
  for (const d of ["results", "shots", "audio", "anim"]) mkdirSync(join(out, d), { recursive: true });
  // previews (gif: the screen as an animated GIF; m4a: the sound): the tour each file plays is o.tours[sha] (a scenario
  // file and where it came from), else o.tours["*"], else scenarios/preview.yaml; each result records it
  const preview = o.gif || o.m4a;
  const tourCache = new Map();
  const tourOf = (sha) => {
    const t = o.tours?.[sha] || o.tours?.["*"] || { scenario: join(ROOT, "scenarios", "preview.yaml"), source: "generic" };
    if (!tourCache.has(t.scenario)) {
      const sc = loadScenario(t.scenario);
      tourCache.set(t.scenario, { sc, hash: tourHash(sc) });
    }
    const c = tourCache.get(t.scenario);
    // a resource file that doesn't check (or isn't there): the preview without it, and why, in the result
    let res = null, resError = null;
    if (t.resources) try { res = parseSpec(t.resources); checkBase(res.base, checkRegion(readFileSync(res.file)).length); } catch (e) { res = null; resError = e.code === "ENOENT" ? "resources: no such file" : e.message; }
    return { sc: c.sc, res, tour: { source: t.source || "generic", hash: c.hash, ...(res ? { resources: resourcesId(res) } : {}), ...(resError ? { resourcesError: resError } : {}) } };
  };
  // one job a distinct file (by content), with every path it was found at
  const bySha = new Map();
  for (const f of files) {
    const sha = createHash("sha256").update(readFileSync(f)).digest("hex");
    if (!bySha.has(sha)) bySha.set(sha, { sha, file: f, paths: [] });
    bySha.get(sha).paths.push(f);
  }
  const jobs = [...bySha.values()];
  const results = new Array(jobs.length);
  let next = 0, done = 0, reused = 0;
  const t0 = Date.now();
  const one = async (j) => {
    const cache = join(out, "results", `${j.sha}.json`);
    if (!o.force && existsSync(cache)) {
      const r = JSON.parse(readFileSync(cache, "utf8"));
      // the preview again when it is missing or its tour has changed; the rest (the flash test) kept
      const want = preview && r.check?.ok ? tourOf(j.sha).tour : null;
      const needPreview = want && (r.preview?.tour?.hash !== want.hash || (r.preview?.tour?.resources || null) !== (want.resources || null) || !r.preview?.stats || (o.gif && !existsSync(join(out, "anim", `${j.sha}.gif`)))
        || (o.m4a && ffmpeg() && !existsSync(join(out, "audio", `${j.sha}.m4a`))));
      if ((!o.brick || r.brick || !r.check.ok) && !needPreview) { reused++; return { ...r, paths: j.paths }; }
      if (needPreview && (!o.brick || r.brick)) j.keep = r;
    }
    const r = { sha: j.sha, name: basename(j.file), paths: j.paths };
    const c = checkPackage(j.file);
    r.check = { ok: c.ok, identity: c.identity, model: c.model, chipKey: c.chipKey, appBytes: c.appBytes, appSlot: c.appSlot, verdict: c.verdict,
                errors: c.errors, findings: c.findings.filter((f) => f.level !== "ok").map((f) => `${f.area}: ${f.text}`) };
    if (c.ok) {
      try {
        const t = preview ? tourOf(j.sha) : { sc: SMOKE, tour: null };
        const run = await runScenario(j.file, t.sc, t.res ? { resources: t.res } : {});
        r.smoke = { pass: run.pass, boots: run.screen.booted, firstScreenMs: run.screen.firstContentMs, sound: run.audio.afterFirstInput.hasSound,
                    peakDb: run.audio.afterFirstInput.peakDb, fault: run.fault, exitCode: run.exitCode, crash: run.crash?.text || null,
                    flash: { reads: run.flashOps.reads, writes: run.flashOps.writes }, frames: run.screen.distinctFrames };
        for (const s of run._raw.shots) if (["boot", "play", "playing"].includes(s.name) && s.img) writeFileSync(join(out, "shots", `${j.sha}-${s.name === "playing" ? "play" : s.name}.png`), png(s.img, 1));
        if (preview) {
          r.preview = { tour: t.tour, stats: previewStats(run, t.sc) };
          if (o.gif) { const g = previewGif(run, t.sc); if (g) { writeFileSync(join(out, "anim", `${j.sha}.gif`), g); r.preview.gif = g.length; } }
          if (o.m4a && r.smoke.sound) { const n = previewAudio(run, t.sc, join(out, "audio", `${j.sha}.m4a`)); if (n) r.preview.audio = n; }
        }
        if (!preview && o.audio !== false && run._raw.audio && r.smoke.sound) {   // 3 s from the note: a preview
          const a = 2000 * 44118 * 4 / 1000, b = Math.min(run._raw.audio.length, a + 3 * 44118 * 4);
          writeFileSync(join(out, "audio", `${j.sha}.wav`), toWav(run._raw.audio.subarray(a - (a % 4), b - (b % 4))));
        }
      } catch (e) { r.smoke = { pass: false, error: String(e.message || e) }; }
      if (j.keep?.brick) r.brick = j.keep.brick;
      else if (o.brick) {
        try { const b = await brickTest(j.file); delete b._panels; r.brick = { verdict: b.verdict, reason: b.reason, puya: b.puya.flash, uc25: b.uc25.flash }; }
        catch (e) { r.brick = { verdict: "error", reason: String(e.message || e) }; }
      }
    }
    r.at = new Date().toISOString();
    const { paths, ...keep } = r;
    writeFileSync(cache, JSON.stringify(keep, null, 1));
    return r;
  };
  await Promise.all(Array.from({ length: Math.max(1, o.jobs || Math.max(1, Math.floor(cpus().length / 2))) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await one(jobs[i]);
      done++;
      o.onProgress?.({ done, total: jobs.length, reused, last: results[i], seconds: (Date.now() - t0) / 1000 });
    }
  }));

  const summary = {
    files: files.length, distinct: jobs.length, invalid: results.filter((r) => !r.check.ok).length,
    boots: results.filter((r) => r.smoke?.boots).length, sound: results.filter((r) => r.smoke?.sound).length,
    crashes: results.filter((r) => r.smoke?.crash || r.smoke?.fault).length,
    brick: o.brick ? Object.fromEntries(["pass", "fail", "warn", "inconclusive", "error"].map((v) => [v, results.filter((r) => r.brick?.verdict === v).length])) : null,
    seconds: Math.round((Date.now() - t0) / 1000), reused,
  };
  writeFileSync(join(out, "results.json"), JSON.stringify({ tool: "fm1-lab sweep", date: new Date().toISOString(), summary, results }, null, 1));
  if (o.brick) writeFileSync(join(out, "brick.json"), JSON.stringify(Object.fromEntries(results.filter((r) => r.brick).map((r) => [r.sha, { verdict: r.brick.verdict, reason: r.brick.reason }])), null, 1));
  writeFileSync(join(out, "index.html"), gallery(results, summary, out));
  return { summary, results, out };
}

function gallery(results, s, out) {
  const tag = (r) => !r.check.ok ? "invalid" : r.smoke?.crash || r.smoke?.fault ? "crash" : !r.smoke?.boots ? "blank" : !r.smoke?.sound ? "silent" : "ok";
  const label = { ok: ["boots, plays", "ok"], silent: ["boots, silent", "warn"], blank: ["blank screen", "bad"], crash: ["crash", "bad"], invalid: ["not a package", "bad"] };
  const bv = { pass: "ok", fail: "bad", warn: "warn", inconclusive: "warn", error: "bad" };
  const cards = results.sort((a, b) => a.name.localeCompare(b.name)).map((r) => {
    const t = tag(r), img = (n) => (n === "play" && existsSync(join(out, "anim", `${r.sha}.gif`)) ? `<img class="shot" loading="lazy" alt="preview" src="anim/${r.sha}.gif">`
      : existsSync(join(out, "shots", `${r.sha}-${n}.png`)) ? `<img class="shot" loading="lazy" alt="${n}" src="shots/${r.sha}-${n}.png">` : `<div class="shot none">no screen</div>`);
    return `<div class="card fw" data-tag="${t}" data-brick="${r.brick?.verdict || ""}" data-name="${esc(r.name.toLowerCase())}">
<b>${esc(r.name)}</b><div class="sub mono">${r.check.ok ? `${esc(r.check.identity)} · ${esc(r.check.model || "")} · ` : ""}${r.sha.slice(0, 10)}</div>
<div class="trio" style="grid-template-columns:1fr 1fr;margin:6px 0">${img("boot")}${img("play")}</div>
<span class="verdict ${label[t][1]}">${label[t][0]}</span>${r.brick ? `<span class="verdict ${bv[r.brick.verdict]}" title="${esc(r.brick.reason)}">UC25 flash: ${r.brick.verdict}</span>` : ""}
${r.smoke?.crash ? `<p class="bad sub">${esc(r.smoke.crash)}</p>` : ""}${!r.check.ok ? `<p class="sub">${esc(r.check.errors.join(" "))}</p>` : ""}
${existsSync(join(out, "audio", `${r.sha}.m4a`)) ? `<audio controls preload="none" src="audio/${r.sha}.m4a"></audio>` : existsSync(join(out, "audio", `${r.sha}.wav`)) ? `<audio controls preload="none" src="audio/${r.sha}.wav"></audio>` : ""}
<p class="sub">${r.paths.length > 1 ? `${r.paths.length} copies · ` : ""}${esc(relative(out, r.paths[0]))}</p></div>`;
  }).join("");
  const body = `<h1>fm1-lab sweep</h1><p class="sub">${s.distinct} firmware files (${s.files} paths) · ${s.seconds} s</p>
<div class="kv"><div><b>${s.boots}</b><span>boot</span></div><div><b>${s.sound}</b><span>make sound</span></div><div><b>${s.crashes}</b><span>crash</span></div><div><b>${s.invalid}</b><span>not packages</span></div>
${s.brick ? Object.entries(s.brick).filter(([, n]) => n).map(([k, n]) => `<div><b>${n}</b><span>UC25 flash: ${k}</span></div>`).join("") : ""}</div>
<p style="margin:14px 0"><input id="q" placeholder="filter by name" style="padding:6px 8px;width:220px">
<select id="t"><option value="">all</option><option>ok</option><option>silent</option><option>blank</option><option>crash</option><option>invalid</option></select>
${s.brick ? `<select id="b"><option value="">any flash result</option><option>pass</option><option>fail</option><option>warn</option><option>inconclusive</option><option>error</option></select>` : ""}</p>
<style>.fws{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}.fw .shot{aspect-ratio:1}</style>
<div class="fws">${cards}</div>
<script>
const q=document.getElementById("q"),t=document.getElementById("t"),b=document.getElementById("b");
function f(){const s=q.value.toLowerCase();for(const c of document.querySelectorAll(".fw"))c.style.display=(!s||c.dataset.name.includes(s))&&(!t.value||c.dataset.tag===t.value)&&(!b||!b.value||c.dataset.brick===b.value)?"":"none"}
for(const e of [q,t,b])e&&e.addEventListener("input",f);
</script>`;
  return page("fm1-lab sweep", body);
}

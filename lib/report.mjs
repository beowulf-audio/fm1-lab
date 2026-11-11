// report.mjs — self-contained HTML reports for run, profile and compare: screenshots and audio embedded, charts as
// inline SVG, no external requests (they open from a CI artifact or a file:// URL).
import { png, diffImage } from "./image.mjs";
import { toWav } from "./audio.mjs";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const b64 = (buf) => Buffer.from(buf).toString("base64");
const imgTag = (img, alt) => (img ? `<img class="shot" alt="${esc(alt)}" src="data:image/png;base64,${b64(png(img, 2))}">` : `<div class="shot none">no frame</div>`);
const audioTag = (raw) => (raw ? `<audio controls preload="none" src="data:audio/wav;base64,${b64(toWav(raw))}"></audio>` : "");
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1b1d21;--mute:#6a6f78;--line:#e2e2de;--ok:#1f7a4d;--bad:#b3261e;--warn:#8a5a00;--a:#3b6fd8;--b:#d0601b;--bar:#3b6fd8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1115;--panel:#171a20;--ink:#e6e7ea;--mute:#9aa0aa;--line:#2a2e36;--ok:#4cc38a;--bad:#ff6b5e;--warn:#e0a83a;--a:#7aa2ff;--b:#ff9a5c;--bar:#7aa2ff}}
:root[data-theme="dark"]{--bg:#0f1115;--panel:#171a20;--ink:#e6e7ea;--mute:#9aa0aa;--line:#2a2e36;--ok:#4cc38a;--bad:#ff6b5e;--warn:#e0a83a;--a:#7aa2ff;--b:#ff9a5c;--bar:#7aa2ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.sub{color:var(--mute)}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.verdict{display:inline-block;font-weight:700;padding:2px 10px;border-radius:999px;border:1px solid currentColor;margin-right:8px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums}code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}.shots figure{margin:0}.shots figcaption{color:var(--mute);font-size:12px;margin-top:4px}
.shot{width:100%;image-rendering:pixelated;border-radius:6px;border:1px solid var(--line);display:block;aspect-ratio:1}.shot.none{display:grid;place-items:center;color:var(--mute)}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}svg{width:100%;height:auto;display:block}svg text{fill:var(--mute);font-size:10px}
audio{width:100%;margin-top:6px}ul{margin:6px 0;padding-left:20px}.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.kv div{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 10px}.kv b{display:block;font-size:18px}.kv span{color:var(--mute);font-size:12px}
@media (max-width:600px){.trio{grid-template-columns:1fr}}`;

export const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}
<p class="sub" style="margin-top:40px">fm1-lab · ${esc(new Date().toISOString().slice(0, 19).replace("T", " "))} UTC · emulated on fm1-emu</p></main></body></html>`;

/** A line chart of one or two series (dB values). */
function lineChart(series, { stepMs = 50, h = 140, min = -80, max = 0, label = "dBFS" } = {}) {
  const W = 1000, n = Math.max(...series.map((s) => s.values.length), 2);
  const x = (i) => 40 + (i / (n - 1)) * (W - 50), y = (v) => 10 + (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min)) * (h - 30);
  const grid = [0, -20, -40, -60, -80].filter((v) => v >= min && v <= max).map((v) => `<line x1="40" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="4" y="${y(v) + 3}">${v}</text>`).join("");
  const secs = Math.floor((n * stepMs) / 1000), ticks = Array.from({ length: secs + 1 }, (_, s) => `<text x="${x((s * 1000) / stepMs)}" y="${h - 4}" text-anchor="middle">${s}s</text>`).join("");
  const paths = series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="1.6" points="${s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)} over time">${grid}${ticks}${paths}</svg>`;
}

/** 24-band spectrum as bars (one or two series side by side). */
function bandChart(series, h = 150) {
  const W = 1000, nb = 24, bw = (W - 50) / nb, min = -110, max = -20;
  const y = (v) => 10 + (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min)) * (h - 30);
  const hz = (i) => Math.round(60 * Math.pow(300, (i + 0.5) / nb));
  let out = [-40, -60, -80, -100].map((v) => `<line x1="40" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="4" y="${y(v) + 3}">${v}</text>`).join("");
  series.forEach((s, k) => s.values.forEach((v, i) => {
    const w = bw / series.length - 2, x0 = 40 + i * bw + k * (w + 1) + 1;
    out += `<rect x="${x0.toFixed(1)}" y="${y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(h - 20 - y(v)).toFixed(1)}" fill="${s.color}" opacity=".85"><title>${hz(i)} Hz: ${v} dB</title></rect>`;
  }));
  for (const i of [0, 4, 8, 12, 16, 20, 23]) { const f = hz(i); out += `<text x="${40 + i * bw + bw / 2}" y="${h - 4}" text-anchor="middle">${f >= 1000 ? (f / 1000).toFixed(1) + "k" : f}</text>`; }
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="spectrum by band">${out}</svg>`;
}

const legend = (items) => `<p class="sub">${items.map(([c, t]) => `<span style="color:${c}">■</span> ${esc(t)}`).join(" &nbsp; ")}</p>`;
const checksTable = (checks) => `<table><tr><th></th><th>check</th><th>detail</th></tr>${checks.map((c) => `<tr><td class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"}</td><td>${esc(c.name)}</td><td>${esc(c.detail)}</td></tr>`).join("")}</table>`;

/** @param r a runScenario() result (with _raw) */
export function runReport(r) {
  const shots = r._raw.shots;
  const body = `<h1>${esc(r.firmware)}</h1><p class="sub">${esc(r.scenario)} · ${r.ms} ms · flash ${esc(r.flash)}${r.strict ? " · cycle-accurate" : ""} · ${r.speed}× real time</p>
<div class="card"><span class="verdict ${r.pass ? "ok" : "bad"}">${r.pass ? "PASS" : "FAIL"}</span>${r.fault ? `<span class="bad">${esc(r.fault)}</span>` : ""}${checksTable(r.checks)}</div>
<div class="kv"><div><b>${r.audio.all.peakDb}</b><span>peak dBFS</span></div><div><b>${r.audio.all.rmsDb}</b><span>rms dBFS</span></div>
<div><b>${r.screen.firstContentMs ?? "–"}</b><span>ms to first screen</span></div><div><b>${r.screen.distinctFrames}</b><span>distinct frames</span></div>
<div><b>${r.flashOps.reads}/${r.flashOps.writes}</b><span>flash reads/writes</span></div><div><b>${pct(r.isrShare)}</b><span>interrupt time, core 0</span></div></div>
${r.crash ? `<h2>Crash</h2><div class="card"><p class="bad">${esc(r.crash.text)}</p><table>
<tr><th>pc</th><td class="mono">0x${(r.crash.pc >>> 0).toString(16)}</td><td>${esc(r.crash.where.pc || "not in the firmware's code")}</td></tr>
<tr><th>returning to</th><td class="mono">0x${(r.crash.rets >>> 0).toString(16)}</td><td>${esc(r.crash.where.rets || "?")}</td></tr>
<tr><th>sp</th><td class="mono">0x${(r.crash.sp >>> 0).toString(16)}</td><td></td></tr>
${r.crash.regs ? `<tr><th>registers</th><td class="mono" colspan="2">${Object.entries(r.crash.regs).map(([k, v]) => `${k} ${(v >>> 0).toString(16)}`).join(" · ")}</td></tr>` : ""}
</table><p class="sub">From the firmware's own fault record (fm1_crash in RAM), named with the build's ELF.</p></div>` : ""}
<h2>Screen</h2><div class="shots">${shots.map((s) => `<figure>${imgTag(s.img, s.name)}<figcaption>${esc(s.name)} · ${s.at} ms${s.said ? `<br><span class="mono">“${esc(s.said)}”</span>` : ""}</figcaption></figure>`).join("")}</div>
${r.usb?.said?.length ? `<h2>What the screen reader heard</h2><div class="card"><table>${r.usb.said.map((x) => `<tr><td class="num">${x.ms} ms</td><td class="mono">${esc(x.text)}</td></tr>`).join("")}</table></div>` : ""}
${r.usb?.midiOut?.length ? `<h2>MIDI out over USB</h2><div class="card"><table>${r.usb.midiOut.slice(0, 200).map((x) => `<tr><td class="num">${x.ms} ms</td><td class="mono">${esc(x.hex)}</td></tr>`).join("")}</table></div>` : ""}
<h2>Sound</h2><div class="card">${audioTag(r._raw.audio)}${lineChart([{ values: r.audio.envelope, color: "var(--a)" }])}<p class="sub">Level over time (50 ms RMS).</p>
${bandChart([{ values: r.audio.bands, color: "var(--a)" }])}<p class="sub">Spectrum after the first input, 60 Hz – 18 kHz.</p></div>`;
  return page(`${r.firmware} run`, body);
}

/** @param p a profile() result (with _ref) */
export function profileReport(p) {
  const h = p.headroom;
  const steps = h.steps.slice(1).map((s) => `<tr><td class="num">${s.mhz} MHz</td><td class="${s.keepsUp ? "ok" : "bad"}">${s.keepsUp ? "keeps up" : "fails"}</td><td class="num">${s.rmsDb >= 0 ? "+" : ""}${s.rmsDb} dB</td><td class="num">${s.bandDb} dB</td><td class="num">${(s.stale * 100).toFixed(1)}%</td><td>${esc((s.why || []).join(", "))}${s.phaseDependent ? " <span class='sub'>(second input phase)</span>" : ""}</td></tr>`).join("");
  const core = (name, c) => !c.running ? `<div class="card"><b>${name}</b> <span class="sub">not running</span></div>` : `<div class="card"><b>${name}</b> <span class="sub">${pct(c.busyShare)} outside wait loops</span>
<table><tr><th>share</th><th></th><th>code</th><th>where</th></tr>${c.regions.filter((r) => r.share >= 0.005).map((r) => `<tr><td class="num">${(r.share * 100).toFixed(1)}%</td><td style="width:35%"><svg viewBox="0 0 100 8" preserveAspectRatio="none" style="height:10px"><rect width="${(r.share * 100).toFixed(1)}" height="8" rx="1.5" fill="var(--bar)"/></svg></td><td class="mono">${esc(r.name)}</td><td>${r.area}, ${r.bytes} B${r.likelyWait ? " · <span class='warn'>wait loop?</span>" : ""}</td></tr>`).join("")}</table></div>`;
  const body = `<h1>${esc(p.firmware)}</h1><p class="sub">profile · ${esc(p.scenario)} · ${p.window[0]}–${p.window[1]} ms, cycle-accurate</p>
<div class="kv"><div><b>${h.headroomShare == null ? "–" : pct(h.headroomShare)}</b><span>CPU headroom at 240 MHz</span></div>
<div><b>${h.neededMhz ? `${h.neededMhz[0] ?? "<"}–${h.neededMhz[1]}` : "–"}</b><span>MHz needed</span></div><div><b>${pct(p.isrShare)}</b><span>interrupt time, core 0</span></div><div><b>${p.bootMs}</b><span>ms to first screen</span></div></div>
<div class="card">${esc(h.note)}${h.warning ? `<p class="warn">${esc(h.warning)}</p>` : ""}</div>
<h2>Headroom</h2><div class="card"><table><tr><th>clock</th><th></th><th>level</th><th>spectrum</th><th>stale</th><th>why</th></tr>${steps}</table>
<p class="sub">Each clock replays the scenario (delayed by the slower boot) and is compared with the 240 MHz run by level, spectrum and stale audio blocks.</p></div>
<h2>Where the time goes</h2>${core("Core 0", p.hotspots.core0)}${core("Core 1", p.hotspots.core1)}
<p class="sub">Time-weighted samples of each core's program counter, grouped into code regions${p.hotspots.symbols ? " by symbol" : ""}. Flat: no call chains.</p>`;
  return page(`${p.firmware} profile`, body);
}

/** @param c a compare() result (with _runs) */
export function compareReport(c) {
  const { a: ra, b: rb } = c._runs;
  const cls = { regression: "bad", different: "warn", same: "ok" }[c.verdict];
  const shotsA = new Map(ra._raw.shots.map((s) => [s.name, s]));
  const screens = rb._raw.shots.map((sB) => {
    const sA = shotsA.get(sB.name), ch = c.screens.find((s) => s.name === sB.name)?.changed ?? 0;
    const diff = sA?.img && sB.img && sA.img.w === sB.img.w ? diffImage(sA.img, sB.img) : null;
    return `<div class="card"><b>${esc(sB.name)}</b> <span class="sub">${sB.at} ms · ${(ch * 100).toFixed(1)}% changed</span>
<div class="trio"><figure>${imgTag(sA?.img, "A")}<figcaption>A · ${esc(c.a)}</figcaption></figure><figure>${imgTag(sB.img, "B")}<figcaption>B · ${esc(c.b)}</figcaption></figure><figure>${imgTag(diff, "diff")}<figcaption>changed pixels</figcaption></figure></div></div>`;
  }).join("");
  const env = lineChart([{ values: ra.audio.envelope, color: "var(--a)" }, { values: rb.audio.envelope, color: "var(--b)" }]);
  const body = `<h1>${esc(c.a)} → ${esc(c.b)}</h1><p class="sub">compare · ${esc(c.scenario)} · ${c.ms} ms${c.strict ? " · cycle-accurate" : ""}</p>
<div class="card"><span class="verdict ${cls}">${c.verdict.toUpperCase()}</span>
${c.regressions.length ? `<ul>${c.regressions.map((m) => `<li class="bad">${esc(m)}</li>`).join("")}</ul>` : ""}
${c.differences.length ? `<ul>${c.differences.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : c.regressions.length ? "" : "<p>No differences.</p>"}</div>
<div class="kv"><div><b>${c.audio.a.rmsDb} → ${c.audio.b.rmsDb}</b><span>rms dBFS</span></div><div><b>${c.cpu.bootMsA} → ${c.cpu.bootMsB}</b><span>ms to first screen</span></div>
<div><b>${pct(c.cpu.isrShareA)} → ${pct(c.cpu.isrShareB)}</b><span>interrupt time</span></div><div><b>${c.flash.a.reads + c.flash.a.writes} → ${c.flash.b.reads + c.flash.b.writes}</b><span>flash operations</span></div>
${c.cpu.headroomA != null ? `<div><b>${pct(c.cpu.headroomA)} → ${pct(c.cpu.headroomB)}</b><span>CPU headroom</span></div>` : ""}</div>
<h2>Sound</h2><div class="card">${legend([["var(--a)", "A " + c.a], ["var(--b)", "B " + c.b]])}
<div class="trio" style="grid-template-columns:1fr 1fr"><div>A ${audioTag(ra._raw.audio)}</div><div>B ${audioTag(rb._raw.audio)}</div></div>
${env}<p class="sub">Level over time (50 ms RMS).</p>${bandChart([{ values: ra.audio.bands, color: "var(--a)" }, { values: rb.audio.bands, color: "var(--b)" }])}
<p class="sub">Spectrum after the first input.${c.audio.identical ? " The audio is bit-identical." : ` Waveform match ${c.audio.similarity}.`}</p></div>
<h2>Screen</h2>${screens}
<h2>Scenario checks</h2><div class="trio" style="grid-template-columns:1fr 1fr"><div class="card"><b>A</b>${checksTable(c.checks.a)}</div><div class="card"><b>B</b>${checksTable(c.checks.b)}</div></div>`;
  return page(`${c.a} vs ${c.b}`, body);
}

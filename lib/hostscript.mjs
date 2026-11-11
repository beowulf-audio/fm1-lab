// hostscript.mjs — fm1-base's host-simulator test scripts (app/tests/*.txt) as fm1-lab scenarios, so one script tests an
// app both in the simulator (fm1-lab test) and on the emulated device with its real package (fm1-lab run, test --emu).
//
// The script's inputs become timed steps (the simulator's own timings: a tap holds 40 ms, a turn's clicks are 80 ms
// apart, ...). Its checks that the emulator can see become timed checks, evaluated against the run with a little slack
// (the device answers a few ms later than the simulator): what the screen reader heard (said, unsaid, said_none: since
// the previous one, as in the simulator), MIDI out over USB (expect midi_out, expect_out USB ...), the sound's peak
// (expect peak_db_min/max, since the last peakreset). The script starts after the device's boot (BOOT_MS), and its
// screen reader from its "listen". Checks of the app's own variables (expect octave 1: the app's
// app_expect) and commands with no emulator counterpart (reboot, power, sd, ble, usbh, wav, ...) are listed as
// simulator-only, not dropped silently.
const BUTTONS = { FX: "FX", SEL: "SCL", ENV: "ENV", LFO: "LFO", EDIT: "EDIT", GLO: "GLO", HOME: "HOME", SAVE: "SAVE", ARP: "ARP",
  SEQ: "SEQ", PLAY: "PLAY", REC: "REC", "OCT-": "OCTDN", "OCT+": "OCTUP" };
const ENCODERS = { SELECT: 0, ALGO: 1, PRESET: 6, K1: 2, K2: 3, K3: 4, K4: 5 };   // fm1-lab's encoder numbers
const WHITE = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26], BLACK = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];   // plat.h
const SLACK_MS = 150, COUNT_SLACK_MS = 40;
// The simulator starts the app at once; the emulated device boots first (it reads no keys for about the first second),
// so a script starts this much later on the emulator, every step and check with it.
export const BOOT_MS = 1000;
const EMU_EXPECT = new Set(["midi_out", "peak_db_min", "peak_db_max"]);

const keyOf = (s) => (s[0] === "w" ? WHITE[+s.slice(1) & 15] : s[0] === "b" ? BLACK[+s.slice(1) % 11] : +s);

/** @returns {{raw:object, timed:Array, skipped:Array, shots:string[]}} raw: a scenario for normalize() */
export function translate(text, name = "host script", { startMs = BOOT_MS } = {}) {
  const steps = [], timed = [], skipped = [], heldBtn = new Map(), heldKey = new Map();
  let t = startMs, lastSaid = startMs, lastOut = startMs, peakFrom = startMs, shotN = 0, readerFrom = null, simOnly = false;
  const skip = (no, line, why) => skipped.push({ line: no, text: line, why });
  text.split("\n").forEach((rawLine, i) => {
    const no = i + 1;
    // "# fm1-lab: simulator only" ... "# fm1-lab: end": the inputs are played, the checks are the simulator's alone
    if (/^\s*#\s*fm1-lab:\s*simulator only/i.test(rawLine)) { simOnly = true; return; }
    if (/^\s*#\s*fm1-lab:\s*end/i.test(rawLine)) { simOnly = false; return; }
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) return;
    if (simOnly && /^(said|unsaid|said_none|expect\w*)\b/.test(line)) { skip(no, line, "marked simulator only (# fm1-lab: simulator only)"); return; }
    const [cmd, a = "", b = "", c = "", d = ""] = line.split(/\s+/);
    const rest = line.slice(cmd.length).trim();
    switch (cmd) {
      case "wait": t += +a; break;
      case "press": case "release": case "tap": {
        const btn = BUTTONS[a]; if (!btn) { skip(no, line, `no button ${a}`); break; }
        if (cmd === "press") { heldBtn.set(btn, t); t += 2; }
        else if (cmd === "release") { const t0 = heldBtn.get(btn) ?? t; heldBtn.delete(btn); steps.push({ at: t0, press: btn, hold: Math.max(10, t - t0) }); t += 2; }
        else { steps.push({ at: t, press: btn, hold: 40 }); t += 80; }
        break;
      }
      case "key": case "tapkey": {
        const k = keyOf(a), vel = +(cmd === "tapkey" ? b : c) || 100;
        if (!(k >= 0 && k <= 26)) { skip(no, line, `no key ${a}`); break; }
        if (cmd === "tapkey") { steps.push({ at: t, note: `n${k}`, vel, hold: 60 }); t += 90; }
        else if (b === "down") { heldKey.set(k, { at: t, vel }); t += 2; }
        else { const h = heldKey.get(k) ?? { at: t, vel }; heldKey.delete(k); steps.push({ at: h.at, note: `n${k}`, vel: h.vel, hold: Math.max(10, t - h.at) }); t += 2; }
        break;
      }
      case "turn": case "spin": {
        const e = ENCODERS[a]; if (e == null) { skip(no, line, `no encoder ${a}`); break; }
        const n = +b, s = Math.sign(n), gap = cmd === "spin" ? 0 : +c || 80;
        if (cmd === "spin") { steps.push({ at: t, turn: e, clicks: n }); t += 1; break; }
        for (let k = 0; k < Math.abs(n); k++) { t += gap; steps.push({ at: t - gap, turn: e, clicks: s }); }
        break;
      }
      case "master": steps.push({ at: t, pot: Math.round((+a / 4096) * 1023) }); t += 40; break;
      case "midi": {
        const port = ["USB", "BLE", "TRS", "BLE-DEV"].includes(a) ? a : "USB", bytes = (port === a ? [b, c, d] : [a, b, c]).filter(Boolean).join(" ");
        if (port === "TRS") steps.push({ at: t, midi: bytes });
        else if (port === "USB") steps.push({ at: t, usb_midi: bytes });
        else skip(no, line, "Bluetooth MIDI: no emulator counterpart");
        t += 2; break;
      }
      case "shot": case "splashshot": steps.push({ at: t, screenshot: (a || `shot${++shotN}`).replace(/\.png$/i, "") }); break;
      case "said": case "unsaid": timed.push({ kind: cmd, line: no, text: rest, from: lastSaid, at: t }); if (cmd === "said") lastSaid = t; break;
      case "said_none": timed.push({ kind: cmd, line: no, from: lastSaid, at: t }); lastSaid = t; break;
      case "where": steps.push({ at: t, usb_midi: "f0 7d 53 52 03 f7" }); t += 2; break;
      case "listen": if (readerFrom == null) readerFrom = t; lastSaid = t; break;   // the reader's HELLOs start here (run.mjs)
      case "peakreset": peakFrom = t; break;
      case "expect":
        if (EMU_EXPECT.has(a)) timed.push({ kind: "expect", line: no, what: a, value: b, from: a === "midi_out" ? 0 : peakFrom, at: t });
        else skip(no, line, "the app's own state (app_expect): simulator only");
        break;
      case "expect_out": case "expect_no_out":
        if (a === "USB") { timed.push({ kind: cmd, line: no, bytes: [b, c, d].filter(Boolean).join(" ").toLowerCase(), from: lastOut, at: t }); lastOut = t; }
        else skip(no, line, `MIDI out on ${a}: not seen by the emulator (USB only)`);
        break;
      default: skip(no, line, "no emulator counterpart");
    }
  });
  // each check's window ends before the next input can show (the device answers 15-20 ms after an input)
  const inputs = steps.filter((x) => x.screenshot == null).flatMap((x) => (x.hold ? [x.at, x.at + x.hold] : [x.at])).sort((a, b) => a - b);
  for (const x of timed) { const nxt = inputs.find((at) => at >= x.at); x.until = nxt == null ? null : nxt + 10; }
  const ms = Math.max(t + 500, 2000);
  return { raw: { name, ms, usb: true, reader: readerFrom != null, reader_from: readerFrom, steps, expect: { boots: true } }, timed, skipped };
}

/** The timed checks against a run (r: runScenario's result, with _raw). */
export function evaluate(timed, r) {
  const said = r.usb?.said || [], out = r.usb?.midiOut || [];
  const peakDb = (from, to) => {
    const raw = r._raw.audio; if (!raw) return -180;
    const a = Math.floor((from / 1000) * 44118), b = Math.min(raw.length / 4, Math.floor(((to + SLACK_MS) / 1000) * 44118));
    let p = 0; for (let i = a; i < b; i++) { const v = Math.max(Math.abs(raw.readInt16LE(i * 4)), Math.abs(raw.readInt16LE(i * 4 + 2))); if (v > p) p = v; }
    return p ? 20 * Math.log10(p / 32768) : -180;
  };
  const cmp = (got, want) => (want[0] === "<" ? got < +want.slice(1) : want[0] === ">" ? got > +want.slice(1) : got === +want);
  return timed.map((x) => {
    const end = (slack) => (x.until == null ? x.at + slack : Math.min(x.at + slack, Math.max(x.at, x.until)));
    const inWin = (m) => m.ms > x.from && m.ms <= end(SLACK_MS);
    const heard = said.filter(inWin).map((s) => s.text).join(" | ");
    const name = `line ${x.line}`;
    switch (x.kind) {
      case "said": return { name, ok: heard.includes(x.text), detail: `said "${x.text}": ${heard ? `heard "${heard}"` : "nothing heard"}` };
      case "unsaid": return { name, ok: !heard.includes(x.text), detail: `unsaid "${x.text}"${heard.includes(x.text) ? `: heard "${heard}"` : ""}` };
      case "said_none": return { name, ok: !heard, detail: heard ? `said_none: heard "${heard}"` : "said_none" };
      case "expect_out": case "expect_no_out": {
        const hit = out.filter(inWin).find((m) => m.hex.replace(/ /g, "").startsWith(x.bytes.replace(/ /g, "")));
        return { name, ok: x.kind === "expect_out" ? !!hit : !hit, detail: `${x.kind} USB ${x.bytes}${hit ? `: ${hit.hex} at ${hit.ms} ms` : ": not sent"}` };
      }
      case "expect":
        // a running count: only the device's own delay (keys answer in 16-20 ms), not what the next steps cause
        if (x.what === "midi_out") { const got = out.filter((m) => m.ms <= end(COUNT_SLACK_MS)).length; return { name, ok: cmp(got, x.value), detail: `midi_out ${x.value}: ${got} sent over USB` }; }
        { const db = peakDb(x.from, x.at), lim = +x.value, ok = x.what === "peak_db_min" ? db >= lim : db <= lim;
          return { name, ok, detail: `${x.what} ${x.value}: peak ${db.toFixed(1)} dBFS` }; }
    }
    return { name, ok: false, detail: `unknown check ${x.kind}` };
  });
}

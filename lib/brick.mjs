// brick.mjs — does a firmware keep using its flash on the UC25HQ80 chip in newer FM-1 units?
//
// Method: boot the firmware twice, identical input, once with the original Puya flash (JEDEC 856014) and once with
// the UC25HQ80 (b36014), and compare how much it uses its flash storage (reads + writes after the ID probe).
// A firmware that only accepts the Puya ID drops to RAM-only storage on the UC25HQ80: it probes the ID, then stops
// touching flash, so saves are lost at power-off and its updater refuses later installs.
import { boot, FLASH } from "./emu.mjs";

// A settings change most firmwares save to flash: two octave-up presses (harmless on every FM-1 firmware), then time
// for an autosave. Boot-only runs miss firmwares that read flash on both chips but only write it on the Puya.
export const DEFAULT_KEYS = "1500:OCTUP,1600:OCTUP^,2500:OCTUP,2600:OCTUP^";

export async function brickTest(fwsc, { ms = 8000, keys = DEFAULT_KEYS } = {}) {
  const [puya, uc25] = await Promise.all([boot(fwsc, { ms, keys, jedec: FLASH.puya }), boot(fwsc, { ms, keys, jedec: FLASH.uc25 })]);
  const use = (r) => r.flash.reads + r.flash.writes;
  const a = use(puya), b = use(uc25);
  let verdict, reason;
  if (puya.code !== 0 && uc25.code !== 0) { verdict = "error"; reason = "The emulator could not run this file."; }
  else if (puya.flash.probes === 0 && uc25.flash.probes === 0) {
    verdict = "pass"; reason = "Never asks the flash chip for its ID, so it behaves the same on both chips.";
  } else if (puya.flash.writes > 0 && uc25.flash.writes === 0) {
    verdict = "fail"; reason = `Saves to flash on the original chip (${puya.flash.writes} writes) but never on the UC25HQ80: changes would be kept in RAM only and lost at power-off.`;
  } else if (a === 0) {
    verdict = "inconclusive"; reason = "Didn't use its flash storage during the test on either chip, so there was nothing to compare. A longer run or a save action is needed.";
  } else if (b >= a * 0.5) {
    verdict = "pass"; reason = `Uses its flash the same way on the UC25HQ80 (${b} storage operations vs ${a} on the original chip).`;
  } else if (b <= a * 0.1) {
    verdict = "fail"; reason = `Checks the chip ID, then stops using its flash on the UC25HQ80 (${b} storage operations vs ${a} on the original chip): saves would be RAM-only and lost at power-off.`;
  } else {
    verdict = "warn"; reason = `Uses its flash much less on the UC25HQ80 (${b} vs ${a} storage operations). Worth a closer look.`;
  }
  const slim = (r) => ({ exitCode: r.code, flash: r.flash, leds: r.leds, audioPeak: r.audioPeak, wallMs: r.wallMs });
  return { file: fwsc, ms, verdict, reason, puya: slim(puya), uc25: slim(uc25), _panels: { puya: puya.panel, uc25: uc25.panel } };
}

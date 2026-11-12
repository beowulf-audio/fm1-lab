# fm1-lab

A test bench for **M-VAVE FM-1** firmware that needs no FM-1. It builds firmware, runs it on an emulated FM-1
([fm1-emu](https://github.com/joakimeriksson/fm1-emu)) and tells you what it did: screenshots and what the screen says,
the sound, MIDI out, flash use, crashes, CPU headroom, and what changed between two builds. For developing firmware,
for CI, and for checking other people's firmware before you install it.

- **Write firmware:** `fm1-lab new` makes a project on [fm1-base](https://github.com/w0ts/fm1-base) that builds and runs in
  seconds; `fm1-lab watch` rebuilds and retests it on every save.
- **Test it:** scenarios (key presses, knobs, MIDI, what to expect), the app's own tests in fm1-base's host simulator and on
  the emulated device, crash reports with the function that crashed.
- **Compare builds:** the same input into two builds; regressions (a crash, silence, saving that stopped) fail, the rest
  is listed.
- **Check firmware:** the newer UC25HQ80 flash chip test (`brick-test`), FM-1 Inspect's package checks, and `sweep` over
  hundreds of files with a gallery.

**New here? [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).**

> **Status: early.** Everything here runs on the emulator. fm1-emu is cycle-accurate where it matters for these checks,
> but nothing in fm1-lab has been compared with a real FM-1 yet, and it does not install anything on one (`flash` and
> `backup` come once they can be tested). Not affiliated with M-VAVE.

### Requirements

- **macOS** (Apple silicon) or **Linux** (x86-64, arm64; [bubblewrap](https://github.com/containers/bubblewrap) for the
  sandbox), Node 22+, git, Rust via [rustup](https://rustup.rs) (the pinned toolchain is installed beside yours)
- for building firmware: Python 3.11+, cmake, ninja and a C++ compiler (macOS: Xcode's command-line tools); building
  the compiler once takes 1-2 hours and ~15 GB while it builds
- Linux also needs the emulator's audio and window libraries: `libasound2-dev libx11-dev libxkbcommon-dev
  libxcursor-dev libxrandr-dev libxi-dev pkg-config`

```sh
git clone https://github.com/beowulf-audio/fm1-lab && cd fm1-lab
node bin/fm1-lab.mjs setup          # or: setup emu, for the commands that only run firmware
npm test                            # unit and sandbox tests; npm run test:e2e: every command on a new project (~45 s)
```

## Commands

```sh
node bin/fm1-lab.mjs setup [--check] [--force] [emu|toolchain|sdk|python ...]
node bin/fm1-lab.mjs new NAME [--dir PARENT] [--id NN] [--author NAME] [--git-name N --git-email E] [--gh-credential] [--no-build]
node bin/fm1-lab.mjs test [DIR] [--emu] [SCRIPT...]
node bin/fm1-lab.mjs watch [DIR] [--scenario S] [--profile P] [--cmd '...'] [--no-test] [--no-flash] [--no-compare]
node bin/fm1-lab.mjs build DIR [--profile P] [--release X] [--cmd '...'] [--root DIR] [--out DIR] [--json OUT] [--run]
node bin/fm1-lab.mjs sweep PATH|@LIST... --out DIR [--brick] [--preview | --gif --m4a] [--tours MAP.json] [--jobs N] [--no-audio] [--force]
node bin/fm1-lab.mjs inspect FILE.fwsc...
node bin/fm1-lab.mjs run [SCENARIO.yaml] FILE.fwsc [--out DIR] [--flash puya|uc25|HEX] [--resources FILE@0xADDR] [--strict] [--html OUT]
node bin/fm1-lab.mjs profile [SCENARIO.yaml] FILE.fwsc [--syms FILE] [--clocks 180,120,90] [--json OUT] [--html OUT]
node bin/fm1-lab.mjs compare [SCENARIO.yaml] A.fwsc B.fwsc [--out DIR] [--strict] [--headroom] [--identical] [--no-retry] [--html OUT]
node bin/fm1-lab.mjs boot FILE.fwsc [--ms 4000] [--jedec b36014] [--keys '1500:OCTUP,1600:OCTUP^'] [--png out.png]
node bin/fm1-lab.mjs brick-test FILE.fwsc... [--ms 8000] [--json report.json] [--png-dir DIR]
```

`--resources FILE@0xADDR` on `run` (and `resources` in a sweep's tour map) puts a firmware's resource region in the
emulated flash before it starts. Some firmwares (fm1-base's `resources =`, Melodee) keep data outside the package in a
region their installer writes after the update, released as `NAME-res.bin` beside the `.fwsc`. Without it they start as
an FM-1 where that step never ran (Polly: "STYLES MISSING"). The address is the app's own (fm1-base: `APP_RES_BASE` in
`app/app.h`) and is in no release file. The file's header (`RES1` or `MRS1`, with its CRC-32s) is checked first, and the
run boots once more to lay the package out.

`--html OUT` on `run`, `profile` and `compare` writes a self-contained report: screenshots and audio embedded, charts as inline SVG, no external requests, so it opens straight from a CI artifact.

### setup

Makes what the other commands need, each pinned and checked: `emu` (the vendored emulator, about a minute), `toolchain`
(the pi32v2-llvm compiler built from reviewed source, 1-2 hours; `docs/toolchain-review.md`), `sdk` (the three AC79 SDK
files packages contain, SHA-256 checked) and `python` (a venv with Pillow for builds' generators). `--check` only reports.

### new

A new firmware project on [fm1-base](https://github.com/w0ts/fm1-base) (MPL-2.0): fm1-base as a git submodule at the commit
fm1-lab's builds were reviewed and validated with, its template as `app/` (renamed, on fm1-base's own Bluetooth stack, so
nothing of JieLi's SDK is linked), a package identity prefix that no firmware in FM-1 Inspect's index uses, an fm1-lab
scenario, and a git repository with one commit (your configured git identity, or `--git-name`/`--git-email`; no remote;
`--gh-credential` makes it log in to GitHub through gh). It then
builds the app in the sandbox, checks the package, runs the scenario and checks both flash chips: about 8 seconds. A fresh clone of the project
builds a byte-identical package.

### test

An fm1-base app's own tests (`app/tests/*.txt`) in fm1-base's host simulator: the platform and the app compiled for
your computer and run faster than real time, in the sandbox; keys, knobs, MIDI and reboots, then checks on the app's state, the
sound's level, MIDI out and what a screen reader says, with screenshots and WAVs. About a second for the template's
tests. It checks the app's logic, UI and sound; the device's timing, drivers and package are the emulator's (`run`,
`profile`, `compare`). Review: `docs/fm1-base-review.md`.

`--emu` runs the same scripts on the emulated device too, with the app's real package: fm1-lab translates a script's
inputs into a scenario (`fm1-lab run app/tests/basic.txt PKG` does the same for one script) and checks what the emulator
can see: what the screen reader heard (`said`, `unsaid`, `said_none`), MIDI out over USB (`expect midi_out`,
`expect_out USB`) and the sound's peak; checks of the app's own variables, and commands with no device counterpart, are
listed as simulator-only. Two differences are built in: the script starts after the device's ~1 s boot (the simulator
starts at once), and a check's window ends before the next input can show. A section between `# fm1-lab: simulator
only` and `# fm1-lab: end` keeps its checks in the simulator (the template's Bluetooth section: the simulator has a
Bluetooth MIDI device to find, the emulator none).

### watch

Rebuilds and retests on every save: the build (sandboxed, with its sizes and what changed since the last build), the
app's host-simulator tests (fm1-base projects), the scenario in the emulator, both flash chips (the original and the
UC25HQ80 in newer units: a build that stops saving on either fails the round), and a comparison with the last build that
passed; a failed stage shows the compiler's or the check's own message and stops the round. Rounds take 5-15 seconds.

### build

Builds a firmware project with that compiler and those SDK files, in the sandbox (no network, writes only inside the
project, nothing in your home folder readable except the project and fm1-lab) and with a clean
environment. fm1-base projects (`fm1-lab new`) build `app/`; Optimist-style projects (`tools/optimist.py`) need `--profile`; Felucca-style ones run `build.sh`; anything
else takes `--cmd`. Every `.fwsc` it makes is checked with FM-1 Inspect's decoder and analysis, and its size reported (app in its slot; RAM, pool and RAM code from fm1-base's sizes.json) with the change since the project's last build; `--run` also boots it
with the smoke scenario. Validation: Optimist v0.3's three published packages, built this way, behave like the author's
release (`docs/toolchain-review.md`). Third-party projects: review the build code first (`docs/optimist-review.md`).

### sweep

Many firmwares at once: each one checked, booted with the smoke scenario (screenshots, a 3-second sound preview, crashes)
and with `--brick` the UC25HQ80 flash test, several at a time. With `--preview` each one plays a short tour instead
(`scenarios/preview.yaml`: the same inputs for every firmware, three keys together, a run of keys, PLAY and a few
preset changes, whose effect depends on the firmware; or the tour `--tours` names for it: `{"SHA-256" or
"*": {"scenario": "tour.yaml", "source": "tailored"}}`) and gets a preview: its screen as an animated GIF (`lib/gif.mjs`:
10 frames a second, the firmware's own palette, only what changes stored; typically 10-90 KB, `--gif`) and its sound as
AAC (`.m4a`, 64 kb/s, about 30-60 KB; needs ffmpeg, `--m4a`). Each preview records its tour (source and hash): when a
file's tour changes, the next sweep makes its preview again and keeps its flash test. Results are kept per file by SHA-256, so a sweep resumes
where it stopped, and a file found twice is run once. `OUT/index.html` is a gallery (filter by name, result and flash
verdict); `OUT/results.json` and `OUT/brick.json` (SHA-256 to verdict, for FM-1 Inspect) are the data.

### inspect

FM-1 Inspect's checks (synced unmodified into `lib/inspect/` by `tools/sync-inspect.sh`): is it a well-formed stock-layout
package, its identity, chip key and app size, and Inspect's static findings (flash-chip support, networking, USB). `run`,
`compare`, `profile` and `boot` check their firmware this way first. Packages for m-bootloader/M-Flasher (another
layout, e.g. pi32v2-isa's examples) are not read by Inspect or the emulator.

### run

Plays a scenario (`scenarios/*.yaml`: key presses, notes, encoder turns, the MASTER pot, MIDI bytes, named screenshots; format at the top of `lib/scenario.mjs`) into a firmware headless and checks its `expect:` block. `--out DIR` writes the screenshots as PNG, `audio.wav` and `run.json`. With `reader: true` (or `said`/`unsaid` checks) an emulated computer on USB speaks fm1-base's screen-reader protocol: each screenshot gets its text, and the scenario can check what the firmware said; `usb_midi` steps send MIDI over USB, and `midi_out` checks look at what it sends back. When the package's ELF is beside it (fm1-base builds), every run also checks for a crash (`no_crash`): the firmware's fault handler keeps the crash in RAM and shows its crash screen, so fm1-lab reads the emulator's RAM at the end and names the faulting address and its caller from the ELF ("crashed 2.03 s after boot: pc 0x0ead0002 (not in the firmware's code); returning to input (unity.c)"). `compare` then also reports text and MIDI-out differences ("heard "OCT +1" where A said "OCTAVE +1""). Without a scenario it runs a built-in smoke test. Exit code 0 when every check passes.

### profile

Where a firmware's CPU time goes and how much it has to spare, cycle-accurately (`FM1_STRICT`, about a third of real-time speed):

- **Hotspots**: time-weighted PC samples of both cores over the scenario (fm1-emu's `FM1_TPROF`), grouped into code regions, or into functions with `--syms` (`nm` output). Tight regions holding most of a core's time are marked as likely wait loops. The profile is flat: no call chains.
- **Headroom**: the scenario again at lower CPU clocks. Timers, the audio link and MIDI keep real time, so a firmware that runs out of CPU misses audio refills (the stale block plays again), drops voices or steps (the level falls) or garbles its output (the spectrum moves). Headroom is `1 − lowest clock that keeps up / 240 MHz`.

Two things that are not overload are allowed for. Boot is CPU-bound, so at each clock the scenario is delayed by the extra boot time. And inputs can land at a moment the firmware treats specially (a key scan, a preset still loading), so every clock is tried at two input phases. A scenario whose audio changes with that phase even at full speed gets a warning.

Examples: X0X 1.2.1 (`scenarios/x0x-play.yaml`) and Felucca 1.8.2-beta (a four-note chord) both keep up at 75 MHz and fail at 60 MHz (about 69% headroom). Felucca fails with stale audio blocks, X0X by dropping level.

### compare

Two builds (A the baseline, B the candidate), the same scenario: what changed, and is any of it a regression? Exit code 1 on a regression, otherwise 0.

- **Regressions**: B faults; a scenario check A passes fails on B; B's screen stays blank or it goes silent; new clipping; stale audio blocks (missed audio refills); saving stopped or flash use collapsed (the brick-test signal); with `--headroom`, at least 10 points less CPU headroom.
- **Differences** (reported, not failing): level and spectrum (the bands that moved most), screenshots (with `--out`: A, B and a diff image per changed screen), flash reads and writes, interrupt time, boot time, headroom.

When it finds anything, both builds run again with every input 37 ms later and only what is found both times counts;
the rest is listed as timing-dependent (`--no-retry` to skip). A burst of encoder clicks in one instant can end on
different values in two builds of one firmware; scenarios can turn knobs at a hand's pace with `click_ms`.

`--identical` turns every difference into a regression, for refactors that should change nothing. Examples: Felucca 1.8.2-beta → 1.7.0 on the UC25HQ80 flash is a regression (flash use 26 → 0 operations); M-VAVE V15 → V16 is different (new tone, slower boot) but not a regression.

### brick-test

Does a firmware keep working on the **UC25HQ80** flash chip in newer FM-1 units? Firmware that only accepts the original Puya chip's ID drops to RAM-only storage on those units: changes are lost at power-off and the updater refuses later installs.

The test boots the firmware twice with identical input (two octave presses, then time for an autosave), once with the Puya flash (`856014`) and once with the UC25HQ80 (`b36014`), and compares how it uses its flash:

- **fail**: it saves on the Puya but never on the UC25HQ80, or stops using flash there altogether
- **pass**: it uses its flash the same way on both, or never checks the chip ID
- **warn / inconclusive**: much less flash use, or no flash use during the test at all

Exit code: 0 all pass, 1 any fail, 2 otherwise. Calibration (`tests/calibration.mjs`) checks it against known cases: Felucca 1.7.0 and Dinghy 0.4 fail; Felucca 1.8.2-beta, SLOOP 2.8.5, Dinghy 0.5 and M-VAVE V15/V16 pass.

## Where things come from

fm1-lab vendors **fm1-emu** unmodified at a pinned commit (`vendor/README.md`: provenance and how to upgrade); its Rust
dependencies come from crates.io, pinned with checksums by its `Cargo.lock`. `patches/0001-fm1-soc-FM1_FLASH_JEDEC.patch`
adds `FM1_FLASH_JEDEC=HHHHHH` (which flash chip the emulator reports), meant for upstream.

`setup toolchain` builds **pi32v2-llvm** (LLVM with a target for the FM-1's CPU) from source at the commits Optimist pins;
`setup sdk` fetches the three files of JieLi's AC79 SDK (Apache-2.0) that FM-1 packages contain, from JieLi's repository,
each checked against its SHA-256. `new` uses **fm1-base** at a pinned commit, and `inspect` FM-1 Inspect's decoder and
checks (`lib/inspect/`, synced unmodified). What was reviewed before any of it ran, and how: `docs/*-review.md`.

## Safety

Everything fm1-lab runs that it didn't write (the emulator, compilers, firmware builds, the host simulator) runs sandboxed
(`lib/sandbox.mjs`): no network, writes only to the run's own directory, and nothing in your home folder readable except
fm1-lab itself and the folders a run needs (no SSH keys, gh or cloud logins, keychains, browser data or other projects).
macOS uses `sandbox-exec` (`lib/sandbox.sb`; the system's temp directories stay writable for compilers); Linux uses
bubblewrap (a private `/tmp`; on Ubuntu 24.04 unprivileged user namespaces must be allowed:
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`). Without either, fm1-lab refuses to run third-party code,
unless `FM1_LAB_SANDBOX=off` says the machine is disposable. `npm test` checks the sandbox on the machine it runs on.

## CI and the GitHub Action

`.github/workflows/ci.yml` runs the tests on Ubuntu, builds the emulator and boots, compares and brick-tests a published
firmware under bubblewrap. `action.yml` makes fm1-lab an Action for a firmware's repository:

    - uses: beowulf-audio/fm1-lab@main
      with:
        command: run scenarios/smoke.yaml app/build/mysynth.fwsc --html report.html

(`toolchain: true` also builds the compiler, 1-2 hours the first time, then cached.) Pin it to a commit (`@<sha>`) for
reproducible results.

## Credits

fm1-lab stands on other people's work, used under their licences:
[fm1-emu](https://github.com/joakimeriksson/fm1-emu) by Joakim Eriksson (MIT), the emulator;
[fm1-base](https://github.com/charlesvestal/fm1-base) by Charles Vestal and contributors, here
[w0ts/fm1-base](https://github.com/w0ts/fm1-base) (MPL-2.0), with Henri David's Bluetooth and Wi-Fi stacks;
[felucca-bsp](https://github.com/hugelton/felucca-bsp) (Hügelton Instruments);
[pi32v2-llvm](https://github.com/jvitkauskas/pi32v2-llvm) and [pi32v2-isa](https://github.com/jvitkauskas/pi32v2-isa)
by Julius Vitkauskas (Apache-2.0 WITH LLVM-exception, MIT-0), the compiler;
[Optimist](https://github.com/w0ts/optimist) (GPL-3.0), whose release build validated the compiler;
[js-yaml](https://github.com/nodeca/js-yaml) (MIT, `lib/vendor/`). FM-1 Inspect's checks are from
[fm1-inspect](https://github.com/beowulf-audio/fm1-inspect).

## Roadmap

- `flash` and `backup` for a real FM-1, with a backup first and the package check before anything is installed
- comparing emulator results with a real FM-1 (sound, timing, CPU headroom)
- a file format for packages made for m-bootloader/M-Flasher

## Licence

MIT (`LICENSE`), for fm1-lab's own code. Vendored and fetched components keep their own licences (above).

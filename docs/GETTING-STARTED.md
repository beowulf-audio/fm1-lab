# Getting started

From nothing to your own FM-1 firmware, tested on an emulated FM-1, in a few commands. macOS (Apple silicon) or Linux
with bubblewrap; Node 22+, Python 3.11+, git, cmake, ninja (`brew install cmake ninja` or `apt install cmake ninja-build`),
Rust via rustup, a C++ compiler (macOS: Xcode's command-line tools). The README lists Linux's extra libraries.

## 1. Set up (once)

    node bin/fm1-lab.mjs setup

This builds the emulator (a minute), builds the compiler from reviewed source (1-2 hours, once), fetches the three SDK
files (hash-checked) and makes a Python environment with Pillow. `setup --check` says what is there. Everything goes
into `.work/`; nothing is installed system-wide. Tip: `alias fm1-lab="node $PWD/bin/fm1-lab.mjs"`.

## 2. A new firmware

    fm1-lab new mysynth --dir ~/fm1-projects

About 5 seconds: a git repository with fm1-base (the platform) as `base/`, your app as `app/` (fm1-base's template:
a simple voice on the keys, settings that save, MIDI over USB, Bluetooth and TRS, a screen reader), a package identity
no other firmware uses, a scenario, and a first commit with your git identity. It is then built, checked and run on the emulated FM-1.

## 3. Write it, with fm1-lab watching

    cd ~/fm1-projects/mysynth
    fm1-lab watch

Edit `app/app.c` (`app_render` makes the sound, `app_frame` draws the screen and reads the controls; `app/app.h` is
the rest of the contract) and save. Each save: a build (with its size and what changed), the app's tests in the host
simulator, the scenario on the emulated FM-1, and a comparison with the last good build. A compile error shows the
compiler's own message; a crash shows where.

## 4. Look and listen

    fm1-lab run scenarios/smoke.yaml app/build/mysynth.fwsc --html report.html && open report.html

Screenshots (with what the screen says), the sound (play it in the page), its level and spectrum, MIDI out, and the
crash if there was one. Scenarios are YAML: key presses, notes, knobs, MIDI, screenshots, and what to expect
(`lib/scenario.mjs` has the format). Add your own to `scenarios/`.

## 5. Test

    fm1-lab test --emu

Your tests in `app/tests/*.txt` run in the host simulator (fast, every check, including your app's own variables) and
on the emulated FM-1 with the real package (what a screen reader hears, MIDI out, the sound). Write tests as you add
features: they are what `watch` runs on every save.

## 6. Did a change break something?

    fm1-lab compare scenarios/smoke.yaml old.fwsc app/build/mysynth.fwsc
    fm1-lab profile scenarios/smoke.yaml app/build/mysynth.fwsc

`compare` plays the same input into two builds: regressions (a crash, silence, a failed check, missed audio refills,
saving that stopped) fail it; differences (level, tone, screens, what the screen says, size) are listed. `profile` says
how much of the CPU your firmware needs and where the time goes. `brick-test` checks it works on the newer flash chip.

## 7. Release

Fill in `app/fm1.toml` (description, tags, tagline, repository, install page, site, screenshot), then

    fm1-lab build . --release 0.1

makes `app/build/mysynth-0.1.fwsc`. Push the repository to GitHub (with `--gh-credential`, `gh auth status` says which
account it will use). Installing on an FM-1 (`fm1-lab flash`, with a backup first) comes when there is one to test it on.

## What is safe

Everything fm1-lab runs that it didn't write (the emulator, the compiler, firmware builds, the host simulator) runs
sandboxed (macOS `sandbox-exec`, Linux bubblewrap): no network, writes only inside the project, and nothing in your home
folder readable but the project and fm1-lab. The compiler, fm1-base, its host simulator and Optimist's build were reviewed before they ran
(`docs/*-review.md`). A third-party project's build code gets the same review before `fm1-lab build` runs it.

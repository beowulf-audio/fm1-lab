# Review: fm1-base and its host simulator

fm1-lab's fm1-base projects (`fm1-lab new`) use **w0ts/fm1-base at 219721955bd660d94b01f2197536bf9bc4eb1052** with its
BSP **hugelton/felucca-bsp at 8d5fd55ed4d8d4feb9f5acd3765a0d03cf9c8ac5**: the tree Optimist v0.3 builds on, whose firmware
build (`tools/build.py APP`) was reviewed in `docs/optimist-review.md` and validated with fm1-lab's compiler in
`docs/toolchain-review.md`. (charlesvestal/fm1-base, the original, differs from it in about 100 files and is not reviewed.)

## The host simulator (`fm1-lab test`), reviewed 2026-11-11, read-only

`tools/build.py APP --host` compiles one file, `host/plat_host.c` (which includes the platform's device-independent
sources, the app's `app.c` and `include/`), with the Mac's C compiler, after the generators the firmware build also runs
(fonts with Pillow, the screen reader's words). The program `APP_host SCRIPT [OUTDIR]` runs a test script faster than
real time and writes PNG screenshots, WAVs and `midi_out.txt` to OUTDIR; exit 0 pass, 1 expectations failed, 2 error.

- In everything compiled into it: no system/popen/exec/fork/posix_spawn, sockets, dlopen, mmap/mprotect, home-directory
  access or file deletion. Its "Wi-Fi" is simulated in the process (no sockets). It reads a few `FM1B_*` environment
  variables (simulated SD card, flash image, CPU load). `host/build_host.sh` is a stale leftover nothing uses.
- Low concerns: paths in a test script are not confined to OUTDIR (`..` and absolute paths work), and its WAV reader
  (`usb_play`) can be made to read out of bounds by a crafted file. The template's scripts use plain file names and no
  WAV input; fm1-lab runs the program in `lib/sandbox.sb` (no network, writes only inside the project, no reading HOME).
- An app's `fm1.toml` can make a build run or compile more of the app's code (`conf_gen`, `gen`, `o2`, `ir_pass`,
  `asm`, `net`): `fm1-lab test` names them; read them before building someone else's app.

What it can and can't check: an app's logic, UI, sound (its audio maths matches the device's: `-ffp-contract=off`),
saving across a reboot, MIDI and what a screen reader would say. Not the device's timing, render budget, code
placement, stacks, drivers or the `.fwsc` package: those are the emulator's (`fm1-lab run`, `profile`, `compare`).

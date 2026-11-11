# Compiler review: pi32v2-llvm

What `tools/setup-toolchain.sh` builds, and what was checked before any of it ran (2026-11-10).

## What it is

- **pi32v2-llvm** (github.com/jvitkauskas/pi32v2-llvm), commit `4f631b31bfc51b8c1d4b5115b9fb954c195a5571`
  (2026-10-29): upstream LLVM plus a target for the FM-1's JieLi pi32v2 CPU. Apache-2.0 WITH LLVM-exception.
- **pi32v2-isa** (github.com/jvitkauskas/pi32v2-isa), commit `e57532149664a53a4184891f0cd5b65bb703cf07`: the
  instruction table, the generators of the target's tables, the build scripts and the drop-in wrapper. MIT-0.
- The commits are the ones Optimist pins (`tools/toolchain.py`), whose firmware built with them was played on an FM-1.
  The LLVM commit is no longer on its branch (rebased since); it is fetched by its full id.
- JieLi's own compiler is not used. Firmware packages still need three files of JieLi's AC79 SDK (Apache-2.0), which
  go into the package and do not run on the host.

## What was checked

1. **The fork's own changes.** The commit is upstream LLVM `7a941dfb2` (release branch) plus 75 commits, all by
   Julius Vitkauskas: 181 files, 246,504 lines added, 26 removed.
2. **Outside the new target** (51 files, 968 lines): read. The usual hooks of a new target (triple, ELF relocations,
   clang target info and driver, lld's backend), plus two compatibility changes for the old (LLVM 4) bitcode of JieLi's
   SDK libraries: the bitcode reader repairs loop debug locations, AutoUpgrade turns JieLi's `llvm.pi32v2.*`
   intrinsics into inline assembly or generic IR. Nothing outside compiling.
3. **Build files:** every CMake change read: source lists and LLVM's standard `tablegen()` steps only; no
   `execute_process`, downloads or custom commands.
4. **Hand-written target code** (~10,000 lines): searched for process execution, networking, environment access,
   file-system calls, fixed paths, dynamic loading and encoded blobs: none. It includes only C++ standard headers
   besides LLVM's own.
5. **Generated code** (~206,000 lines: the instruction descriptions, the assembler's tables, operand, fixup,
   compression and relaxation tables): regenerated from `isa/pi32v2.toml` with pi32v2-isa's `tools/llvm/gen_td.py`
   (in the sandbox, from a copy with the generated files deleted) and compared: all seven files byte-identical.
6. **Scripts that run:** `tools/llvm/package.sh` (CMake + Ninja, install, archive), `tools/llvm/build_builtins.sh`
   (compiles compiler-rt's builtins with the new clang), `tools/dropin/make_dropin.sh` (copies and links) and the
   wrapper `tools/dropin/jlwrap.py` (runs on every compile; calls only the drop-in's own LLVM tools): read; no network.
   `pi32v2isa/oracle.py` can download JieLi's toolchain (hash-checked, from JieLi's server) for research, but only
   through `python -m pi32v2isa oracle ...`; nothing in the build or the wrapper imports it.
7. pi32v2-isa contains an `AGENTS.md`; it was treated as data and not followed.

## How it runs

- The build and the drop-in assembly run under `lib/sandbox.sb`: no network, writes only under `.work/toolchain` and the
  system's temporary directories.
- Firmware builds with it are to run under the same profile, writing only to the project's build directory.

## Changes for macOS

- `package.sh` is used with `-DLLVM_BUILD_STATIC=OFF` (macOS cannot link statically).
- `patches/toolchain/0001-pi32v2-llvm-macos-uint8-cast.patch`: the cast Apple clang requires in `PI32V2AsmBackend.cpp`
  (as Optimist's BUILDING.md describes; meant for upstream).

## Validation: Optimist v0.3 rebuilt and compared with the release (2026-11-11)

The three published packages of Optimist v0.3 (`docs/optimist-review.md`), built with this compiler in the sandbox
(18 s each), against the author's release assets:

| Profile | Size | Bytes differing | Smoke | Tour, normal | Tour, cycle-accurate |
| --- | --- | --- | --- | --- | --- |
| synths-2 | 692,813 = release | 5,997 (0.9%) | bit-identical | bit-identical | bit-identical (knobs 1 click / 250 ms) |
| drum-machines | 688,698 = release | 5,417 (0.8%) | bit-identical | bit-identical | bit-identical |
| mots-config | 856,356 = release | 8,957 (1.0%) | bit-identical | same sound (match 1.0) | same sound and screens (match 1.0) |

The differing bytes are what Optimist's BUILDING.md describes for any two builds of one tree ("the same size, not
always the same bytes": constants placed in another order). In cycle-accurate runs, fast knob turns could end on a
different value (Optimist accelerates fast turns, and its timing shifts with code placement); one click per 250 ms
removes that. `scenarios/tour.yaml` is the scenario.

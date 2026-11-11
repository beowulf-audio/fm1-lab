# Build review: Optimist v0.3

What running Optimist's release build involves, and what was checked before any of it ran (2026-11-10). Purpose: rebuild
the three published v0.3 packages with fm1-lab's self-built compiler and compare them with the author's release.

## What

- Optimist (github.com/w0ts/optimist), tag `v0.3` = commit `d10a804e84f094fee5f332ff65eb5c176440c842`, GPL-3.0. Submodules
  at the commits v0.3 records: `fm1base` 2197219 (w0ts/fm1-base), its `bsp` 8d5fd55 (hugelton/felucca-bsp),
  `third_party/m-bootloader` 6bc8f45, `third_party/m-flasher` 1309094. All fetched anonymously over HTTPS (fm1base's
  URL is an SSH one in `.gitmodules`; it was rewritten so no SSH key could be offered).
- The command, as the author's `release.yml` runs it: `python tools/optimist.py package --profile P --release 0.3` for
  P = synths-2, drum-machines, mots-config.

## What runs (traced statically, nothing executed)

`tools/optimist.py package` → `tools/builder/configure.py` (writes the configuration) → `tools/fm1base.py` → a fixed
`python fm1base/tools/build.py fm1base/optimist --sdk $AC79_SDK --release 0.3` with `JIELI_DOCKER=0`, which:
generates the configuration, fonts and words (`fm1base/optimist/gen_optimist.py`, `fm1base/tools/gen_font.py`,
`gen_words.py`, and eight of Optimist's `tools/gen_*.py`); cross-compiles the loader and the app with the pi32v2
compiler (`clang`, `ld`, `objcopy`, `objdump` of the drop-in); runs pure-Python checks over the objdump text and the ELF
(`ir_pass`, `ramcode`, `romref`, `ram_run`, `stack_depth`/`stack_ir`, `boot_pack`, `mmio_check`); and packs the `.fwsc`
(`fm1base/tools/fm1pkg_make.py`). Other programs: `git`, read-only (`rev-parse`, `ls-files`, `diff`, `status`).

**Nothing is compiled for the host and run.** Host compiles exist only behind other flags (`--host`, `--web`, `--rfm1`)
and in the SD-card packager (`tools/sd_zip.py`, which compiles and runs `tools/sd_factory.c`), which runs only when a
profile sets `SDCARD=1`: none of the three published profiles does (default 0; only the unpublished `sd-*` profiles).
Docker is used only when `JIELI_DOCKER=1`.

## What was checked

Four independent reviews, read-only, none executing repo code:

1. **The entry path**, read in full: `tools/optimist.py`, `tools/build.py`, `toolchain.py`, `shared.py`, `repo_root.py`,
   `srcgit.py`, `progress.py`, `deps.py`, `setup_env.py`, `build.sh`, `Makefile`.
2. **Optimist's generators and packaging**, 25 files read in full (`fm1pkg_make`, `gen_font`, `builder/configure`,
   `lz4blk`, `lzb`, `farcalls`, `flash_layout`, `gen_samples`, `gen_x0x_drums`, `sd_zip`, ...); `builder/core.py` and
   `registry.py` (pure configuration logic) by import and call analysis plus the header generator. Every generated C
   header comes from repo data (WAVs, the BDF font, JSON, Python tables, the `.config`), nothing fetched.
3. **fm1base's release build**, read in full: `fm1base/tools/build.py` (2,007 lines) and the helpers it imports,
   `fm1pkg_make.py`, `fm1base/optimist/gen_optimist.py`, `ir_pass.py`, and the BSP host scripts it uses.
4. **A sweep of all host-side code** (every `.py`, `.sh`, Makefile, `.mjs` in tools, fm1base, third_party, firmware,
   config, tests) for network, process execution, eval/exec, encoded payloads, dynamic imports, home-directory and
   secret access, persistence, sudo/rm/chmod; every hit on the build path (73 files) read by hand.

Findings:

- **Nothing malicious; no network, secret access, persistence, telemetry, time-based logic or obfuscation on the build
  path.** No encoded blobs; no prebuilt host binaries anywhere (submodules included); no `.pth`/sitecustomize files.
- Network and other notable code exists only in other commands, not reachable from `package`: `setup`'s downloads
  (`deps.py`: urllib, pip, the SHA-pinned toolchain), the USB rescue/installer tools (`fm1_rescue.*`: curl, pip, sudo,
  scans `~/Downloads`), `get_sdk.sh`/`get_toolchain.sh`, the cloud-build CI scripts (`cloud_shelf.sh` sets
  `git config --global` on CI), the author's build-farm scripts (ssh), `emu.py` (git clone), a sample downloader not in the
  generator list, and a local web server for `site`/`serve` (127.0.0.1).
- Read-only fallbacks to `~/fw-AC79_AIoT_SDK` and a parent-directory search for a toolchain apply only when
  `AC79_SDK` / `PI32V2_LLVM_TOOLCHAIN` are unset: both are set.
- `fm1base/skill/felucca-to-fm1-base/SKILL.md` is an AI-agent porting guide; it tells an agent to use a signed-in `gh`
  and to install firmware on a device. Treated as data, not followed.

## How it runs

- Under `lib/sandbox.sb`: no network; writes only inside `.work/optimist-v0.3` and temp; nothing in HOME readable except
  fm1-lab (the tree, the toolchain, the SDK files, the Python venv) and the Python installation.
- A clean environment (`env -i`): only PATH, HOME, the toolchain and SDK paths, `JIELI_DOCKER=0`, and
  `GIT_CONFIG_GLOBAL=/dev/null` (git can't read `~/.gitconfig` in the sandbox anyway).
- Python 3.12 venv with Pillow 12.2.0 only (`.work/pyenv`).
- Outputs: `build/`, `fm1base/optimist/build/`, `dist/`, `fm1base/optimist/web/words/` (all inside the tree).

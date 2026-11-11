# vendor/fm1-emu

[fm1-emu](https://github.com/joakimeriksson/fm1-emu) by Joakim Eriksson, MIT licence (`fm1-emu/LICENSE`), at commit
`5c6ed85df0b0bf6f0a400ce0887750707c7509ed`, unmodified. Only what building `fm1-live` and `fm1-emu` needs is kept:
`Cargo.toml`, `Cargo.lock`, `LICENSE`, `README.md` and `crates/` (without `crates/fm1-plugin`, a separate workspace).

fm1-lab's changes are in `../patches/` and are applied to a scratch copy at build time (`tools/setup-emu.sh`), so
this directory always matches upstream and an upgrade is a clean replacement.

Upgrading: replace this directory with the same files from the new commit, update the commit above, run
`tools/setup-emu.sh` (the patches must still apply), then `node tests/calibration.mjs DIR`: all cases must agree.

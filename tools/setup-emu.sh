#!/bin/bash
# Build fm1-emu from the vendored source (vendor/fm1-emu, see vendor/README.md) with fm1-lab's patches applied:
# fm1-live and fm1-emu into .work/target/release.
#   tools/setup-emu.sh        needs rustup; installs the pinned Rust toolchain alongside your default
# Rust dependencies come from crates.io, pinned with checksums by vendor/fm1-emu/Cargo.lock (--locked).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN=1.95.0                       # fm1-emu uses `if let` guards (stable after 1.88)
VENDOR="$ROOT/vendor/fm1-emu"
SRC="$ROOT/.work/fm1-emu-src"          # a scratch copy: vendored source + patches, rebuilt every run

rm -rf "$SRC"; mkdir -p "$SRC"
cp -R "$VENDOR/." "$SRC/"
# git apply inside a git work tree (fm1-lab's own checkout: .work/ is in it) applies a patch's paths relative to that
# tree's top and silently skips the ones outside the current directory, i.e. all of them: the ceiling keeps git from
# finding fm1-lab's repository, and any "Skipped" line, or a file the patch names left unchanged, stops the setup.
for p in "$ROOT"/patches/*.patch; do
  [ -e "$p" ] || continue
  echo "applying $(basename "$p")"
  out=$( cd "$SRC" && GIT_CEILING_DIRECTORIES="$(dirname "$SRC")" git apply -v -p1 "$p" 2>&1 ) || { echo "$out"; exit 1; }
  if echo "$out" | grep -q "^Skipped"; then echo "$out"; echo "setup-emu: $(basename "$p") was not applied"; exit 1; fi
  for f in $(grep '^+++ b/' "$p" | sed 's#^+++ b/##'); do
    cmp -s "$VENDOR/$f" "$SRC/$f" && { echo "setup-emu: $(basename "$p") left $f unchanged"; exit 1; }
  done
done
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal
( cd "$SRC" && CARGO_TARGET_DIR="$ROOT/.work/target" cargo +"$TOOLCHAIN" build --locked --release -p fm1-live -p fm1-emu )
echo "built: $ROOT/.work/target/release/fm1-live"

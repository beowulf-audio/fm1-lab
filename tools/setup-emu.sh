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
for p in "$ROOT"/patches/*.patch; do
  [ -e "$p" ] || continue
  echo "applying $(basename "$p")"
  ( cd "$SRC" && git apply -p1 "$p" )
done
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal
( cd "$SRC" && CARGO_TARGET_DIR="$ROOT/.work/target" cargo +"$TOOLCHAIN" build --locked --release -p fm1-live -p fm1-emu )
echo "built: $ROOT/.work/target/release/fm1-live"

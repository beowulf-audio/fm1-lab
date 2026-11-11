#!/bin/bash
# Build the pi32v2-llvm compiler (Julius Vitkauskas's LLVM with a target for the FM-1's JieLi pi32v2 CPU; Apache-2.0
# WITH LLVM-exception, its tools MIT-0) from source at pinned commits, as the drop-in that FM-1 firmware builds use:
# .work/toolchain/pi32v2-llvm-dropin-<llvm>-<isa>/. About an hour or two on 8 cores, ~15 GB while building.
# macOS and Linux (x86-64, arm64).
#   tools/setup-toolchain.sh            needs git, cmake, ninja, python3 (3.11+), a C++ compiler (macOS: Xcode's
#                                       command-line tools; Linux: build-essential), bubblewrap on Linux
#
# The commits are the ones Optimist pins (tested on an FM-1). The build runs sandboxed: no network, no reading HOME
# outside fm1-lab, and files can only be written under .work/toolchain. Review: docs/toolchain-review.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$ROOT/.work/toolchain"
LLVM_COMMIT=4f631b31bfc51b8c1d4b5115b9fb954c195a5571   # github.com/jvitkauskas/pi32v2-llvm (rebased off its branch since)
ISA_COMMIT=e57532149664a53a4184891f0cd5b65bb703cf07    # github.com/jvitkauskas/pi32v2-isa
VER="${LLVM_COMMIT:0:9}-${ISA_COMMIT:0:7}"
OUT="$T/pi32v2-llvm-dropin-$VER"
[ -d "$OUT" ] && { echo "already built: $OUT"; exit 0; }
for t in git cmake ninja python3; do command -v $t >/dev/null || { echo "setup-toolchain: $t is missing (macOS: brew install $t; Linux: apt install $t)" >&2; exit 1; }; done
mkdir -p "$T"

# anonymous over HTTPS only: no credential helpers, no prompts, no SSH (so no account's key or login can be used)
git() { GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=false command git -c credential.helper= -c protocol.allow=never -c protocol.https.allow=always "$@"; }
fetch() {   # fetch URL DIR COMMIT: just that commit, shallow
  local url=$1 dir=$2 commit=$3
  if [ ! -d "$dir/.git" ]; then git init -q "$dir"; git -C "$dir" remote add origin "$url"; fi
  git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" checkout -q --force "$commit"
  git -C "$dir" clean -qfdx
  [ "$(git -C "$dir" rev-parse HEAD)" = "$commit" ] || { echo "setup-toolchain: $dir is not at $commit" >&2; exit 1; }
}
echo "fetching sources (pinned commits)"
fetch https://github.com/jvitkauskas/pi32v2-llvm "$T/LLVM" "$LLVM_COMMIT"
fetch https://github.com/jvitkauskas/pi32v2-isa "$T/ISA" "$ISA_COMMIT"
for p in "$ROOT"/patches/toolchain/*.patch; do echo "applying $(basename "$p")"; git -C "$T/LLVM" apply "$p"; done

# package.sh as it is on Linux; on macOS linked dynamically (macOS can't link statically: Optimist's BUILDING.md)
PKG="$T/ISA/tools/llvm/package.sh"
if [ "$(uname -s)" = Darwin ]; then
  sed 's/-DLLVM_BUILD_STATIC=ON/-DLLVM_BUILD_STATIC=OFF/' "$T/ISA/tools/llvm/package.sh" > "$T/ISA/tools/llvm/package-macos.sh"
  grep -q 'LLVM_BUILD_STATIC=OFF' "$T/ISA/tools/llvm/package-macos.sh"
  PKG="$T/ISA/tools/llvm/package-macos.sh"
fi

# the sandbox (lib/sandbox.mjs): sandbox-exec on macOS, bubblewrap on Linux
if [ "$(uname -s)" = Darwin ]; then
  SB=(/usr/bin/sandbox-exec -f "$ROOT/lib/sandbox.sb" -D "HOME=$HOME" -D "WORK=$T" -D "READ1=$ROOT" -D "READ2=/nonexistent")
elif command -v bwrap >/dev/null; then
  SB=(bwrap --die-with-parent --unshare-net --unshare-ipc --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs "$HOME" --ro-bind "$ROOT" "$ROOT" --bind "$T" "$T" --remount-ro "$HOME")
elif [ "${FM1_LAB_SANDBOX:-}" = off ]; then SB=()
else echo "setup-toolchain: no sandbox (install bubblewrap), or FM1_LAB_SANDBOX=off on a disposable machine" >&2; exit 1; fi
echo "building clang, ld.lld and the tools (in the sandbox)"
( cd "$T/ISA" && "${SB[@]}" sh "$PKG" "$T/LLVM" "$T/build" "$T/prefix/pi32v2-llvm" )
echo "assembling the drop-in"
( cd "$T/ISA" && "${SB[@]}" sh tools/dropin/make_dropin.sh --copy "$T/prefix/pi32v2-llvm/bin" "$T/build/runtime" "$OUT.part" )
mkdir -p "$OUT.part/licenses"
cp "$T/LLVM/llvm/LICENSE.TXT" "$OUT.part/licenses/LLVM-LICENSE.TXT"
cp "$T/ISA/LICENSE" "$OUT.part/licenses/pi32v2-isa-LICENSE"
cp -R "$T/ISA/LICENSES" "$OUT.part/licenses/pi32v2-isa-LICENSES"
cp "$ROOT"/patches/toolchain/*.patch "$OUT.part/licenses/"
printf 'pi32v2-llvm %s\npi32v2-isa %s\nbuilt by fm1-lab tools/setup-toolchain.sh on %s\n' "$LLVM_COMMIT" "$ISA_COMMIT" "$(uname -sm)" > "$OUT.part/BUILD-INFO"
mv "$OUT.part" "$OUT"
"$OUT/llvm/bin/clang" --version | head -1
echo "built: $OUT"
echo "use:   PI32V2_LLVM_TOOLCHAIN=$OUT"

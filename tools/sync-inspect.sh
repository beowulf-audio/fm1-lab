#!/bin/bash
# FM-1 Inspect's checks (github.com/beowulf-audio/fm1-inspect, site/js) into lib/inspect/, unmodified, at a pinned
# commit: the package decoder (fwsc.js), the static analysis (analyze.js) and the fingerprinting (fingerprint.js,
# match.js). Fixes go into fm1-inspect; then bump COMMIT and run this again.
#   tools/sync-inspect.sh         from ../fm1-inspect if it has the commit, otherwise fetched anonymously over HTTPS
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT=a8a373367ddf441822175838720790f4cfc0c1c2
FILES=(fwsc.js analyze.js fingerprint.js match.js)
SRC="$ROOT/../fm1-inspect"
if ! git -C "$SRC" cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  SRC="$ROOT/.work/fm1-inspect"
  [ -d "$SRC/.git" ] || { git init -q "$SRC"; git -C "$SRC" remote add origin https://github.com/beowulf-audio/fm1-inspect; }
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=false git -C "$SRC" -c credential.helper= fetch -q --depth 1 origin "$COMMIT"
fi
mkdir -p "$ROOT/lib/inspect"
for f in "${FILES[@]}"; do git -C "$SRC" show "$COMMIT:site/js/$f" > "$ROOT/lib/inspect/$f"; done
printf 'github.com/beowulf-audio/fm1-inspect site/js at %s, unmodified (tools/sync-inspect.sh)\n' "$COMMIT" > "$ROOT/lib/inspect/SOURCE"
echo "synced ${FILES[*]} at ${COMMIT:0:7}"

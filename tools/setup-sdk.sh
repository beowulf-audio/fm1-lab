#!/bin/bash
# The three files of JieLi's AC79 SDK (Apache-2.0) that FM-1 firmware packages contain, from JieLi's own repository at
# the tag Optimist pins, each checked against its pinned SHA-256: .work/sdk/cpu/wl82/tools/. They go into packages;
# none of them runs on this computer.
#   tools/setup-sdk.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
D="$ROOT/.work/sdk/cpu/wl82/tools"
URL=https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK/raw/AC79NN_SDK_V1.2.1_2023-12-13/cpu/wl82/tools
FILES=(
  "uboot.boot 4e3b4c220dc96641cb5a723f41e68ce41d5261ae9434bb33fbd7f2c59976ded4"
  "cfg_tool.bin 276579954f076886a6a7694f65dc71c034a63a2c204b76749065c0ac7b010d1b"
  "cfg/eq_cfg_hw.bin 41167491bffed4651750719c973d2758adeb9021a5670d02d6a53c85ed80ea7d"
)
mkdir -p "$D/cfg"
for entry in "${FILES[@]}"; do
  read -r f sha <<< "$entry"
  if [ -f "$D/$f" ] && [ "$(shasum -a 256 "$D/$f" | cut -d' ' -f1)" = "$sha" ]; then echo "ok      $f"; continue; fi
  curl -fsSL --retry 3 --proto '=https' -m 120 -o "$D/$f.part" "$URL/$f"
  got=$(shasum -a 256 "$D/$f.part" | cut -d' ' -f1)
  if [ "$got" != "$sha" ]; then rm -f "$D/$f.part"; echo "setup-sdk: $f has SHA-256 $got, not the pinned $sha: discarded" >&2; exit 1; fi
  mv "$D/$f.part" "$D/$f"; echo "fetched $f (SHA-256 verified)"
done
echo "sdk: $ROOT/.work/sdk"

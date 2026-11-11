#!/bin/bash
# The Python environment firmware builds use: .work/pyenv with Pillow (fonts and icons) at a pinned version.
#   tools/setup-python.sh        needs python3 3.11 or newer
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PILLOW=12.2.0
V="$ROOT/.work/pyenv"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || { echo "setup-python: python3 3.11 or newer is needed" >&2; exit 1; }
[ -x "$V/bin/python" ] || python3 -m venv "$V"
if "$V/bin/python" -c "import PIL, sys; sys.exit(0 if PIL.__version__ == '$PILLOW' else 1)" 2>/dev/null; then
  echo "ok      Pillow $PILLOW"
else
  "$V/bin/pip" install -q --disable-pip-version-check "Pillow==$PILLOW"; echo "installed Pillow $PILLOW"
fi
echo "python: $V ($("$V/bin/python" -V))"

#!/usr/bin/env bash
set -euo pipefail
PRAGMA_HOME="${PRAGMA_HOME:-$(git config --path --get pragma.home || true)}"
PRAGMA_HOME="${PRAGMA_HOME:-$HOME/.pragma}"
if [[ ! -x "$PRAGMA_HOME/lib/format.sh" ]]; then
  printf 'Pragma not found at %s. Set PRAGMA_HOME or rerun install.sh.\n' "$PRAGMA_HOME" >&2
  exit 1
fi
exec "$PRAGMA_HOME/lib/format.sh" "$@"

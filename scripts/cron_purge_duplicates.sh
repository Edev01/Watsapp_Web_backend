#!/usr/bin/env bash
# Cron wrapper for duplicate purge → trash table.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/logs"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
exec /usr/bin/python3 "$ROOT/scripts/purge_duplicates.py" --apply "$@"

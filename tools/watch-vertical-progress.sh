#!/usr/bin/env bash
# Refresh the derived vertical dashboard until interrupted (Ctrl-C).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
while true; do
  clear
  node "$root/tools/vertical-progress.mjs" "$root"
  sleep 2
done

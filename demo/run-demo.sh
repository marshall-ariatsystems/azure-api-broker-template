#!/usr/bin/env bash
# run-demo.sh — launch the two-pane broker demo in tmux:
#   LEFT  = backend audit log (Azure broker: auth + key injection)
#   RIGHT = frontend pi agent (no key present; real LLM calls through the broker)
#
# Prereqs: tmux, az logged in, and clients/broker.env populated + clients/.broker-venv present
# (run clients/setup-pi.sh once). Usage: ./run-demo.sh [model-id]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MODEL="${1:-openai/gpt-4o-mini}"
VENV="$ROOT/clients/.broker-venv"
ENVF="$ROOT/clients/broker.env"
SESSION="broker-demo"

command -v tmux >/dev/null || { echo "tmux not installed"; exit 1; }
[ -f "$ENVF" ] || { echo "missing $ENVF — run clients/setup-pi.sh and set the secret"; exit 1; }
[ -x "$VENV/bin/python" ] || { echo "missing venv — run clients/setup-pi.sh"; exit 1; }

tmux kill-session -t "$SESSION" 2>/dev/null || true
# Left pane: backend log tail
tmux new-session -d -s "$SESSION" -x 220 -y 50 "bash '$HERE/backend-watch.sh'"
# Right pane: frontend agent (source the pi-agent identity first)
tmux split-window -h -t "$SESSION" \
  "cd '$HERE'; source '$ENVF'; '$VENV/bin/python' frontend.py '$MODEL'; echo; read -p '[enter to close]'"
tmux set -t "$SESSION" mouse on
tmux select-pane -t "$SESSION".1   # focus the frontend so you can type
echo "Attaching… (left: backend, right: frontend). Detach with Ctrl-b then d."
tmux attach -t "$SESSION"

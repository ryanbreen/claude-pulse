#!/usr/bin/env bash
# Auto-restart supervisor for claude-pulse TUI.
# Restarts on crash (OOM, signals) but exits cleanly on user quit (exit 0).
# Logs each restart/crash to ~/Downloads/claude-pulse-crashes.log.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

CRASH_LOG="${HOME}/Downloads/claude-pulse-crashes.log"
RESTART_DELAY=2
MAX_RAPID_CRASHES=5
RAPID_WINDOW=60  # seconds

# Load .env if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export NODE_OPTIONS="--expose-gc --max-old-space-size=512"

# Build before starting so we always run the latest source
echo "[pulse] Building..." >&2
npx tsc || { echo "[pulse] Build failed, aborting." >&2; exit 1; }

crash_times=()

while true; do
  set +e
  # Run node directly. Keyboard input (q, Ctrl+C) works because the terminal
  # passes stdin through to the child process when run interactively.
  # stderr goes to crash log for heap watchdog messages.
  node dist/index.js "$@" 2>>"$CRASH_LOG"
  exit_code=$?
  set -e

  # Clean exit: code 0 (q key), 130 (Ctrl+C/SIGINT), 143 (SIGTERM)
  if [ "$exit_code" -eq 0 ] || [ "$exit_code" -eq 130 ] || [ "$exit_code" -eq 143 ]; then
    exit 0
  fi

  now=$(date +%s)
  crash_times+=("$now")

  echo "[$(date -Iseconds)] claude-pulse exited with code ${exit_code}" >> "$CRASH_LOG"

  # Count crashes within the rapid window
  recent=0
  for t in "${crash_times[@]}"; do
    if (( now - t < RAPID_WINDOW )); then
      (( recent++ ))
    fi
  done

  if (( recent >= MAX_RAPID_CRASHES )); then
    echo "claude-pulse crashed ${recent} times in ${RAPID_WINDOW}s — giving up. See ${CRASH_LOG}" >&2
    exit 1
  fi

  echo "claude-pulse restarting in ${RESTART_DELAY}s... (exit ${exit_code}, ${recent}/${MAX_RAPID_CRASHES} rapid)" >&2
  sleep "$RESTART_DELAY"
done

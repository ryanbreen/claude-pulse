#!/usr/bin/env bash
# Auto-restart supervisor for claude-pulse TUI.
# Restarts on crash (OOM, signals) but exits cleanly on user quit (exit 0).
# Logs each crash to ~/Downloads/claude-pulse-crashes.log for diagnosis.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

CRASH_LOG="${HOME}/Downloads/claude-pulse-crashes.log"
RESTART_DELAY=2
MAX_RAPID_CRASHES=5
RAPID_WINDOW=60  # seconds

crash_times=()

while true; do
  set +e
  # Use compiled version (npm run start) for stability.
  # stderr goes to crash log so heap watchdog messages are captured.
  npm run start -- "$@" 2>>"$CRASH_LOG"
  exit_code=$?
  set -e

  # Clean exit (user pressed q) — stop the supervisor
  if [ "$exit_code" -eq 0 ]; then
    exit 0
  fi

  now=$(date +%s)
  crash_times+=("$now")

  # Log the crash
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

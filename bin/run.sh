#!/usr/bin/env bash
# Run pulse in a loop. Restarts on crash, stops on Ctrl+C.
cd "$(dirname "$0")/.." || exit 1

if [ -f .env ]; then
  set -a; source .env; set +a
fi
export NODE_OPTIONS="--expose-gc --max-old-space-size=512"

tsc || { echo "Build failed." >&2; exit 1; }

while true; do
  node dist/index.js "$@" &
  NODE_PID=$!
  trap "kill $NODE_PID 2>/dev/null; exit" SIGINT SIGTERM
  wait $NODE_PID
  exit_code=$?
  [ "$exit_code" -eq 0 ] && exit 0
  echo "Restarting in 2s... (exit $exit_code)" >&2
  sleep 2
done

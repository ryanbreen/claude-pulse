#!/usr/bin/env bash
# Run pulse in a loop. Restarts on crash, stops on clean exit or Ctrl+C.
cd "$(dirname "$0")/.." || exit 1
trap exit SIGINT SIGTERM
while true; do
  npm run start
  echo "Restarting in 2s..." >&2
  sleep 2
done

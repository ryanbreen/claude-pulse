#!/usr/bin/env bash
# Auto-restart wrapper for claude-pulse TUI
# Restarts after crash (OOM, etc.) with a 2s cooldown

cd "$(dirname "$0")/.." || exit 1

while true; do
  npm run dev
  echo "claude-pulse exited with code $?. Restarting in 2s..."
  sleep 2
done

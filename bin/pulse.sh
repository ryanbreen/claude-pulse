#!/usr/bin/env bash
# Launcher for claude-pulse. Builds and runs via node directly.
# Node handles its own restart logic (max lifetime, heap watchdog).
# No bash supervisor loop — node must be the direct child of the terminal
# for stdin TTY passthrough (required for keyboard input in Ink).

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

# Load .env if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export NODE_OPTIONS="--expose-gc --max-old-space-size=512"

# Build
echo "[pulse] Building..." >&2
npx tsc || { echo "[pulse] Build failed." >&2; exit 1; }

# exec replaces the bash process with node, giving it direct TTY access.
# Without exec, node is a child of bash and stdin.isTTY is undefined.
exec node dist/index.js "$@"

#!/bin/bash
# claude-jump.sh - Jump to recently completed Claude sessions via yabai
# Usage: claude-jump.sh next | claude-jump.sh prev

STATE_FILE="/tmp/claude-pulse-state.json"
CURSOR_FILE="/tmp/claude-pulse-cursor"

if [ ! -f "$STATE_FILE" ]; then
  echo "No claude-pulse state file found. Is claude-pulse running?" >&2
  exit 1
fi

DIRECTION="${1:-next}"

# Read current cursor
CURSOR=-1
if [ -f "$CURSOR_FILE" ]; then
  CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "-1")
fi

# Get the currently focused window ID so we can skip it
FOCUSED_WINDOW=$(yabai -m query --windows --window 2>/dev/null | python3 -c "
import json, sys
try:
    w = json.load(sys.stdin)
    print(w.get('id', ''))
except:
    pass
" 2>/dev/null)

# Resolve window IDs for all completed sessions, find next/prev that isn't current
WINDOW_ID=$(python3 -c "
import json, subprocess, sys

with open('$STATE_FILE') as f:
    state = json.load(f)

completed = state.get('completed', [])
if not completed:
    sys.exit(1)

focused = '$FOCUSED_WINDOW'

# Query yabai once for all window matching
try:
    result = subprocess.run(['yabai', '-m', 'query', '--windows'],
                          capture_output=True, text=True, timeout=3)
    all_windows = json.loads(result.stdout)
except:
    all_windows = []

ghostty = [w for w in all_windows if w.get('app') == 'Ghostty']

def resolve_window(entry):
    \"\"\"Resolve a completed session to a yabai window ID.\"\"\"
    wid = entry.get('windowId')
    # Verify cached window ID still exists
    if wid:
        for w in all_windows:
            if w.get('id') == wid:
                return wid
    # Fallback: match by CWD basename
    cwd = entry.get('cwd', '')
    basename = cwd.rstrip('/').split('/')[-1].lower() if cwd else ''
    if basename:
        for w in ghostty:
            title = w.get('title', '').lower()
            if title == basename or basename in title:
                return w['id']
    return None

# Build list of (index, window_id) for entries that resolve to a window
candidates = []
for i, entry in enumerate(completed):
    wid = resolve_window(entry)
    if wid is not None and str(wid) != focused:
        candidates.append((i, wid))

if not candidates:
    sys.exit(1)

cursor = $CURSOR
direction = '$DIRECTION'

# Find where we are in the candidates list
current_pos = -1
for j, (idx, wid) in enumerate(candidates):
    if idx == cursor:
        current_pos = j
        break

if direction == 'next':
    new_pos = (current_pos + 1) % len(candidates)
else:
    new_pos = (current_pos - 1) % len(candidates)

chosen_idx, chosen_wid = candidates[new_pos]

# Output: cursor_index window_id
print(f'{chosen_idx} {chosen_wid}')
" 2>/dev/null)

if [ -n "$WINDOW_ID" ]; then
  NEW_CURSOR=$(echo "$WINDOW_ID" | awk '{print $1}')
  WIN_ID=$(echo "$WINDOW_ID" | awk '{print $2}')
  echo "$NEW_CURSOR" > "$CURSOR_FILE"
  yabai -m window --focus "$WIN_ID" 2>/dev/null
fi

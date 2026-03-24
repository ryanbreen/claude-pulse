#!/bin/bash
# claude-jump.sh - Jump to recently completed Claude sessions
# Navigates: workspace → Ghostty window → tab
# Usage: claude-jump.sh next | claude-jump.sh prev

STATE_FILE="/tmp/claude-pulse-state.json"
CURSOR_FILE="/tmp/claude-pulse-cursor"

if [ ! -f "$STATE_FILE" ]; then
  exit 1
fi

DIRECTION="${1:-next}"

CURSOR=-1
if [ -f "$CURSOR_FILE" ]; then
  CURSOR=$(cat "$CURSOR_FILE" 2>/dev/null || echo "-1")
fi

# Select next/prev completed session from the stack
RESULT=$(python3 -c "
import json, sys

with open('$STATE_FILE') as f:
    state = json.load(f)

completed = [c for c in state.get('completed', []) if c.get('workspace')]
if not completed:
    sys.exit(1)

cursor = $CURSOR
direction = '$DIRECTION'

# Find current position
current_pos = -1
for j, entry in enumerate(completed):
    if j == cursor:
        current_pos = j
        break

if direction == 'next':
    new_pos = (current_pos + 1) % len(completed)
else:
    new_pos = (current_pos - 1) % len(completed)

entry = completed[new_pos]
tab = entry.get('tabTitle', '') or ''
print(f'{new_pos}|{entry[\"workspace\"]}|{tab}|{entry[\"cwd\"]}')
" 2>/dev/null)

if [ -z "$RESULT" ]; then
  exit 1
fi

IFS='|' read -r NEW_CURSOR SPACE TAB_TITLE CWD <<< "$RESULT"
echo "$NEW_CURSOR" > "$CURSOR_FILE"

# Step 1: Switch workspace
CURRENT_SPACE=$(yabai -m query --spaces 2>/dev/null | python3 -c "
import json, sys
for s in json.load(sys.stdin):
    if s.get('has-focus'):
        print(s['index'])
        break
" 2>/dev/null)

if [ -n "$SPACE" ] && [ "$CURRENT_SPACE" != "$SPACE" ]; then
  yabai -m space --focus "$SPACE" 2>/dev/null
  sleep 0.2
fi

# Step 2: Focus a Ghostty window on that workspace
yabai -m query --windows --space "$SPACE" 2>/dev/null | python3 -c "
import json, sys
windows = [w for w in json.load(sys.stdin) if w.get('app') == 'Ghostty']
if windows:
    print(windows[0]['id'])
" 2>/dev/null | read -r WIN_ID

if [ -n "$WIN_ID" ]; then
  yabai -m window --focus "$WIN_ID" 2>/dev/null
  sleep 0.1
fi

# Step 3: Switch to the correct tab by clicking it in the Window menu
if [ -n "$TAB_TITLE" ]; then
  osascript -e "
    tell application \"System Events\"
      tell process \"Ghostty\"
        set targetLower to do shell script \"echo \" & quoted form of \"$TAB_TITLE\" & \" | tr '[:upper:]' '[:lower:]'\"
        set menuItems to every menu item of menu \"Window\" of menu bar 1
        repeat with mi in menuItems
          set itemName to name of mi
          if itemName is not missing value then
            set itemLower to do shell script \"echo \" & quoted form of (itemName as text) & \" | tr '[:upper:]' '[:lower:]'\"
            if itemLower contains targetLower or targetLower contains itemLower then
              click mi
              exit repeat
            end if
          end if
        end repeat
      end tell
    end tell
  " 2>/dev/null
fi

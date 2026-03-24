#!/bin/bash
# claude-jump.sh - Jump to recently completed Claude sessions
# Navigates to the correct workspace, focuses the Ghostty window,
# switches to the right tab, and navigates to the pane.
# Usage: claude-jump.sh next | claude-jump.sh prev

STATE_FILE="/tmp/claude-pulse-state.json"
CURSOR_FILE="/tmp/claude-pulse-cursor"
PODS_STATE="$HOME/.claude-pods/state.json"

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

# Get the currently focused window ID (used for ordering, not filtering)
FOCUSED_WINDOW=$(yabai -m query --windows --window 2>/dev/null | python3 -c "
import json, sys
try:
    w = json.load(sys.stdin)
    print(w.get('id', ''))
except:
    pass
" 2>/dev/null)

# Resolve completed sessions and find next/prev target
RESULT=$(python3 -c "
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

def normalize(s):
    return s.lower().replace('_', ' ').replace('-', ' ')

def resolve_window(entry):
    # First: check cached window ID still exists
    wid = entry.get('windowId')
    if wid:
        for w in all_windows:
            if w.get('id') == wid:
                return w
    # Second: match CWD basename to window title (flexible matching)
    cwd = entry.get('cwd', '')
    basename = cwd.rstrip('/').split('/')[-1] if cwd else ''
    norm_base = normalize(basename)
    if norm_base:
        # Exact normalized match first
        for w in ghostty:
            if normalize(w.get('title', '')) == norm_base:
                return w
        # Substring match
        for w in ghostty:
            title = normalize(w.get('title', ''))
            if norm_base in title or title in norm_base:
                return w
    # Third: try matching against pod state — find the workspace, then
    # match only if there's exactly one Ghostty window on that workspace
    try:
        import os
        pods_file = os.path.expanduser('~/.claude-pods/state.json')
        with open(pods_file) as pf:
            pods = json.load(pf)
        for pod in pods.get('pods', []):
            if pod.get('active') and pod.get('directory') == cwd:
                ws = pod.get('workspace')
                ws_windows = [w for w in ghostty if w.get('space') == ws]
                if len(ws_windows) == 1:
                    return ws_windows[0]
                break
    except:
        pass
    return None

# Build list of (index, window, entry) for entries that resolve
candidates = []
for i, entry in enumerate(completed):
    win = resolve_window(entry)
    if win is not None:
        candidates.append((i, win, entry))

if not candidates:
    sys.exit(1)

cursor = $CURSOR
direction = '$DIRECTION'

current_pos = -1
for j, (idx, win, entry) in enumerate(candidates):
    if idx == cursor:
        current_pos = j
        break

if direction == 'next':
    new_pos = (current_pos + 1) % len(candidates)
else:
    new_pos = (current_pos - 1) % len(candidates)

chosen_idx, chosen_win, chosen_entry = candidates[new_pos]

# Output: cursor_index window_id space_number cwd
space = chosen_win.get('space', chosen_entry.get('windowSpace', 0))
print(f'{chosen_idx}|{chosen_win[\"id\"]}|{space}|{chosen_entry[\"cwd\"]}')
" 2>/dev/null)

if [ -z "$RESULT" ]; then
  exit 1
fi

IFS='|' read -r NEW_CURSOR WIN_ID SPACE CWD <<< "$RESULT"
echo "$NEW_CURSOR" > "$CURSOR_FILE"

# Step 1: Switch to the correct workspace
CURRENT_SPACE=$(yabai -m query --spaces | python3 -c "
import json, sys
for s in json.load(sys.stdin):
    if s.get('has-focus'):
        print(s['index'])
        break
" 2>/dev/null)

if [ "$CURRENT_SPACE" != "$SPACE" ] && [ -n "$SPACE" ] && [ "$SPACE" != "0" ]; then
  yabai -m space --focus "$SPACE" 2>/dev/null
  sleep 0.2
fi

# Step 2: Focus the Ghostty window
yabai -m window --focus "$WIN_ID" 2>/dev/null
sleep 0.1

# Step 3: Switch to the correct tab using pod state
# We use the Ghostty Window menu to find tab names for the focused window,
# then match the CWD basename to find the right tab index
if [ -n "$CWD" ]; then
  CWD_BASENAME=$(basename "$CWD")

  # Use AppleScript to get the list of tabs in the focused window
  # and click the one matching our target
  osascript -e "
    tell application \"System Events\"
      tell process \"Ghostty\"
        set menuItems to name of every menu item of menu \"Window\" of menu bar 1
        set targetName to \"$CWD_BASENAME\"

        -- Find and click the matching menu item
        repeat with itemName in menuItems
          if itemName is not missing value then
            set lowerItem to do shell script \"echo \" & quoted form of (itemName as text) & \" | tr '[:upper:]' '[:lower:]'\"
            set lowerTarget to do shell script \"echo \" & quoted form of targetName & \" | tr '[:upper:]' '[:lower:]'\"
            if lowerItem contains lowerTarget or lowerTarget contains lowerItem then
              click menu item (itemName as text) of menu \"Window\" of menu bar 1
              exit repeat
            end if
          end if
        end repeat
      end tell
    end tell
  " 2>/dev/null
fi

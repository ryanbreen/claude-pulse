# Claude Pulse

A terminal dashboard for monitoring all your active Claude Code sessions in real-time.

```
CLAUDE PULSE                                                    7:20:58 PM | 3s refresh | q quit
────────────────────────────────────────────────────────────────────────────────────────────────────
ACTIVE            IDLE              TOTAL             CPU               MEMORY
 2                 15                17                42.6%             10.6 GB
LONGEST           24H SESSIONS      24H PROJECTS      24H PEAK
 24h 47m           25                11                9 @ 4:40am
────────────────────────────────────────────────────────────────────────────────────────────────────
SESSIONS
████████████████████████████████████████████████████████████████████████████████████████ peak 17
CPU LOAD
██████████▃▃▃▂▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ peak 41%
Working ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 2/17
24H ACTIVITY (10-min buckets)
····················▒░▓▓█▓▒▓▒▒░▓▓▓▓░·▓▒░▓▓▒▒░░▓▒▒·░▒▒▓▒▓░···░░░··░░░▒▒░···▒▓▒▒░▓▒▓▓░···········
 0             3              6              9             12            15             18
────────────────────────────────────────────────────────────────────────────────────────────────────
  PID    TTY    UPTIME    CPU    MEM    MODE     DIRECTORY
⚡16424  s047   2h 39m    28.8%  997M   new      ~/fun/code/claude_pulse
⚡23147  s048   24h 38m   13.1%  1049M  continue ~/fun/code/breenix
○ 87695  s002   14h 12m   0.0%   779M   resume   ~/getfastr/code/penpot
...
```

## Install & Run

```bash
git clone https://github.com/ryanbreen/claude-pulse.git
cd claude-pulse
npm install
npm run dev
```

## Usage

- **`npm run dev`** - Launch the interactive TUI (refreshes every 3 seconds)
- **`npm run dev -- --snapshot`** - Print a single snapshot and exit (good for piping)
- **`q`** - Quit the TUI

## What it monitors

- **Active sessions** - Claude processes currently using CPU (working autonomously)
- **Idle sessions** - Claude processes waiting for input
- **Per-session details** - PID, TTY, uptime, CPU%, memory, mode (new/continue/resume), working directory
- **Sparklines** - Session count and CPU load over the last hour
- **Working gauge** - Visual ratio of active vs idle sessions
- **24h activity heatmap** - When you were busiest, scaled to terminal width
- **24h peak** - Most concurrent sessions and when it happened

## How it works

Session detection uses `ps -eo` to find all `claude --*` processes, then a single batched `lsof` call to resolve working directories. Historical data comes from `~/.claude/history.jsonl`. All UI elements scale to fill your terminal width.

## License

ISC

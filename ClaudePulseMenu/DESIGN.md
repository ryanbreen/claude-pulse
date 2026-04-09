# ClaudePulseMenu — SwiftUI Menu Bar App

## Overview

A macOS menu bar app that monitors active Claude Code sessions. Shows a live session count in the menu bar icon area. Clicking reveals a popover with session details.

## Architecture

```
Sources/ClaudePulseMenu/
  App.swift                    — Entry point, MenuBarExtra
  Scanner/
    Models.swift               — ClaudeSession, TurnState, etc.
    ProcessScanner.swift       — ps + lsof parsing → [ClaudeSession]
    TurnStateDetector.swift    — JSONL tail-read for turn state detection
  Views/
    MenuPopoverView.swift      — Main popover content
    SessionRowView.swift       — Single session row
    StatsBarView.swift         — Summary stats bar
  State/
    SessionManager.swift       — @Observable, timer-driven refresh
```

## Data Flow

1. `SessionManager` fires a 3-second Timer
2. On tick: calls `ProcessScanner.scan()` → `[ClaudeSession]`
3. `ProcessScanner.scan()`:
   a. Runs `ps -eo pid,ppid,tty,etime,%cpu,rss,command` via Process
   b. Filters for `claude` processes with `--` args
   c. Builds PID→PPID map, detects subagents (ancestor is also claude, or --print flag)
   d. Runs single batched `lsof -a -d cwd -p <pids> -F pn` for working directories
   e. Calls `TurnStateDetector.detect(cwd:sessionId:)` for each non-subagent
4. SessionManager publishes `sessions`, `activeCount`, `idleCount`, `totalCpu`, `totalMemMB`
5. SwiftUI MenuBarExtra renders count in menu bar, popover shows details

## Module Specs

### Models.swift

```swift
enum TurnState: String {
    case working, idle, stalled, unknown
}

struct ClaudeSession: Identifiable {
    let id: Int          // pid
    let pid: Int
    let ppid: Int
    let tty: String
    let elapsed: String
    let elapsedSeconds: Int
    let cpuPercent: Double
    let rssMB: Double
    let command: String
    var cwd: String
    let flags: [String]        // "continue", "resume", or empty
    let sessionId: String?
    let isSubagent: Bool
    var turnState: TurnState
}
```

### ProcessScanner.swift

Pure functions, no state. All shell commands via `Process` + `Pipe`.

```swift
struct ProcessScanner {
    static func scan() -> [ClaudeSession]
}
```

**ps parsing**: Same regex as TS version — match lines where command contains `claude` followed by ` --`. Extract pid, ppid, tty, etime, %cpu, rss, command. Parse etime format: `[[DD-]HH:]MM:SS` → seconds.

**Subagent detection**: Build full PID→PPID map from ps. For each claude process, walk up to 3 ancestors. If any ancestor PID is also a claude session PID → subagent. Also: if command contains `--print` → subagent.

**lsof**: Batch all PIDs into one call. Parse `p<pid>\nn<path>` format. Assign cwd to each session.

**Session ID extraction**: Regex `--session-id\s+([a-f0-9-]+)` or `-s\s+([a-f0-9-]+)` from command string.

### TurnStateDetector.swift

```swift
struct TurnStateDetector {
    static func detect(cwd: String, sessionId: String?) -> TurnState
}
```

**JSONL location**: `~/.claude/projects/<cwd-path-dashes>/<sessionId>.jsonl` or most recent `.jsonl` in that directory.

**Tail read**: Read last 128KB of JSONL file using `FileHandle`, seekToEnd - 128KB.

**Parse each JSON line** for these timestamps:
- `lastHumanMessageTs`: entries with `type: "human"` and `message.role: "user"`, excluding tool_results
- `lastAssistantAnyTs`: entries with `type: "assistant"`
- `lastTurnEndTs`: entries with `type: "system"` and `subtype` of `turn_duration` or `stop_hook_summary`
- `lastToolUseTs`: assistant entries containing `tool_use` content blocks
- `lastToolResultTs`: human entries containing `tool_result` content blocks

**State derivation** (same logic as TS):
1. If `lastTurnEndTs >= lastHumanMessageTs` → `.idle`
2. If tool_use with no tool_result yet → `.working`
3. If assistant responded, no turn_duration for 30s, CPU < 3% → `.idle`
4. If no assistant response for 30s, CPU < 3% → `.stalled`
5. Otherwise → `.working`

**Caching**: Keep a dict of `[String: (mtimeMs: TimeInterval, state: TurnState)]` keyed by JSONL path. Skip re-parse if mtime unchanged.

### SessionManager.swift

```swift
@Observable
class SessionManager {
    var sessions: [ClaudeSession] = []
    var activeCount: Int = 0
    var idleCount: Int = 0
    var stalledCount: Int = 0
    var totalCount: Int = 0   // interactive only
    var subagentCount: Int = 0
    var totalCpu: Double = 0
    var totalMemMB: Double = 0
    var longestSession: Int = 0   // seconds
    
    func startPolling()   // 3s timer
    func stopPolling()
}
```

The timer fires on a background queue. After scanning, results are published on MainActor.

`activeCount` = interactive sessions where turnState == .working OR (turnState == .unknown AND cpuPercent > 3.0)

### App.swift

```swift
@main
struct ClaudePulseMenuApp: App {
    @State private var manager = SessionManager()
    
    var body: some Scene {
        MenuBarExtra {
            MenuPopoverView(manager: manager)
        } label: {
            Label("\(manager.activeCount)/\(manager.totalCount)", systemImage: "bolt.fill")
        }
        .menuBarExtraStyle(.window)
    }
}
```

Uses `.window` style for a real popover (not just a menu). The label shows `⚡ 3/7` (active/total) in the menu bar.

### MenuPopoverView.swift

```swift
struct MenuPopoverView: View {
    let manager: SessionManager
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            StatsBarView(manager: manager)
            Divider()
            // Session list — interactive sessions sorted by CPU desc
            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(sortedSessions) { session in
                        SessionRowView(session: session)
                    }
                }
            }
            Divider()
            // Footer
            HStack {
                Text("\(manager.totalCount) sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .buttonStyle(.plain)
                    .font(.caption)
            }
        }
        .padding(12)
        .frame(width: 420, maxHeight: 500)
    }
}
```

### StatsBarView.swift

A horizontal bar showing key stats:
```
Active: 3 ⚡  Idle: 4  Stalled: 1 ✕  |  CPU: 45.2%  MEM: 1.2 GB  |  Longest: 2h 15m
```

Use colored text: green for active, yellow for idle, red for stalled. Monospaced numbers.

### SessionRowView.swift

Each row shows:
```
● PID   TTY    UPTIME   CPU    MEM    MODE        DIRECTORY
```

- Status dot: 🔴 stalled, 🟢 working+high CPU, 🟡 working, ⚪ idle
- Colored CPU text (green >10%, yellow >1%, gray otherwise)
- Colored uptime (red >12h, yellow >1h)
- Directory path truncated from left if needed
- Subagent rows are dimmed/indented

## Build & Run

```bash
cd ClaudePulseMenu
swift build
swift run
```

Or open in Xcode: `open Package.swift`

## Key Differences from Node.js Version

1. **No Ink/React** — native SwiftUI, no element leak concerns
2. **No sparklines/heatmap** — menu bar popover keeps it compact; may add later
3. **No Cloudflare reporting** — read-only monitor for now
4. **No history.jsonl parsing** — focus on live sessions only
5. **No usage tracking** — token limits not shown (can add later)

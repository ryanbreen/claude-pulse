import { writeFileSync } from "fs";
import { execSync } from "child_process";
import { ACTIVE_CPU_THRESHOLD, type ClaudeSession } from "./scanner.js";

const STATE_PATH = "/tmp/claude-pulse-state.json";

interface YabaiWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  space: number;
  display: number;
  "has-focus": boolean;
}

interface CompletedSession {
  pid: number;
  cwd: string;
  completedAt: number; // timestamp when it went idle
  windowId: number | null; // yabai window id
  windowTitle: string | null;
}

// Track which sessions were previously active
let previouslyActive = new Set<number>();
const completedQueue: CompletedSession[] = [];
let cursor = -1; // current position in the queue, -1 = no selection

function queryYabaiWindows(): YabaiWindow[] {
  try {
    const output = execSync("yabai -m query --windows 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    return JSON.parse(output) as YabaiWindow[];
  } catch {
    return [];
  }
}

function matchSessionToWindow(
  session: ClaudeSession,
  windows: YabaiWindow[]
): YabaiWindow | null {
  const ghosttyWindows = windows.filter((w) => w.app === "Ghostty");
  if (ghosttyWindows.length === 0) return null;

  // Extract the meaningful part of the CWD for matching
  const cwdParts = session.cwd.split("/");
  const cwdBasename = cwdParts[cwdParts.length - 1]?.toLowerCase() ?? "";
  // Also try parent/child for worktree paths like .../worktrees/main
  const cwdParentChild =
    cwdParts.length >= 2
      ? `${cwdParts[cwdParts.length - 2]}/${cwdParts[cwdParts.length - 1]}`.toLowerCase()
      : "";

  // Try exact basename match first
  for (const w of ghosttyWindows) {
    const title = w.title.toLowerCase();
    if (title === cwdBasename) return w;
  }

  // Try substring match (window title contains cwd basename or vice versa)
  for (const w of ghosttyWindows) {
    const title = w.title.toLowerCase();
    if (cwdBasename && title.includes(cwdBasename)) return w;
    if (cwdBasename && cwdBasename.includes(title) && title.length > 2)
      return w;
  }

  // Try parent/child match for worktree-style paths
  if (cwdParentChild) {
    for (const w of ghosttyWindows) {
      const title = w.title.toLowerCase();
      if (title.includes(cwdParentChild)) return w;
    }
  }

  return null;
}

function isSessionWorking(s: ClaudeSession): boolean {
  return (
    s.turnState === "working" ||
    (s.turnState === "unknown" && s.cpuPercent > ACTIVE_CPU_THRESHOLD)
  );
}

export function updateCompletedSessions(sessions: ClaudeSession[]): void {
  const interactive = sessions.filter((s) => !s.isSubagent);
  const currentlyActive = new Set(
    interactive.filter(isSessionWorking).map((s) => s.pid)
  );

  // Find sessions that were active last tick but are now idle = just completed
  const newlyCompleted = interactive.filter(
    (s) => previouslyActive.has(s.pid) && !currentlyActive.has(s.pid)
  );

  if (newlyCompleted.length > 0) {
    const windows = queryYabaiWindows();
    const now = Date.now();

    for (const s of newlyCompleted) {
      const win = matchSessionToWindow(s, windows);
      // Remove if already in queue (re-completed)
      const existing = completedQueue.findIndex((c) => c.pid === s.pid);
      if (existing !== -1) completedQueue.splice(existing, 1);

      completedQueue.unshift({
        pid: s.pid,
        cwd: s.cwd,
        completedAt: now,
        windowId: win?.id ?? null,
        windowTitle: win?.title ?? null,
      });
    }

    // Keep only the last 50
    while (completedQueue.length > 50) completedQueue.pop();
    // Reset cursor when new completions arrive
    cursor = -1;
  }

  // Also remove sessions that no longer exist
  const alivePids = new Set(interactive.map((s) => s.pid));
  for (let i = completedQueue.length - 1; i >= 0; i--) {
    if (!alivePids.has(completedQueue[i].pid)) {
      completedQueue.splice(i, 1);
    }
  }

  previouslyActive = currentlyActive;

  // Write state for skhd scripts to read
  writeState(interactive);
}

function writeState(interactive: ClaudeSession[]): void {
  try {
    const state = {
      updated: Date.now(),
      activeCount: interactive.filter(isSessionWorking).length,
      totalCount: interactive.length,
      cursor,
      completed: completedQueue,
    };
    writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch {
    // non-critical
  }
}

export function getCompletedQueue(): CompletedSession[] {
  return completedQueue;
}

export function getActiveCount(sessions: ClaudeSession[]): number {
  return sessions.filter((s) => !s.isSubagent && isSessionWorking(s)).length;
}

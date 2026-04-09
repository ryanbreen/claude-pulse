import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { ACTIVE_CPU_THRESHOLD, type ClaudeSession } from "./scanner.js";

const STATE_PATH = "/tmp/claude-pulse-state.json";
const PODS_STATE_PATH = join(homedir(), ".claude-pods", "state.json");

interface YabaiWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  space: number;
  display: number;
  "has-focus": boolean;
}

interface PodEntry {
  id: string;
  directory: string;
  workspace: number;
  mode: string;
}

interface CompletedSession {
  pid: number;
  cwd: string;
  completedAt: number;
  workspace: number | null;
  tabTitle: string | null;
}

// Track which sessions were previously active
let previouslyActive = new Set<number>();
const completedQueue: CompletedSession[] = [];
let cursor = -1;

// Track workspace info for working sessions (needed to focus after crash)
let previousWorkingInfo = new Map<number, { workspace: number | null; tabTitle: string | null }>();
// Don't re-alert for the same stalled session
const alertedStalled = new Set<number>();

// Cache pod state (re-read every 30s)
let podsCacheTime = 0;
let podsCache: PodEntry[] = [];

function loadPods(): PodEntry[] {
  const now = Date.now();
  if (now - podsCacheTime < 30_000 && podsCache.length > 0) return podsCache;
  try {
    const data = JSON.parse(readFileSync(PODS_STATE_PATH, "utf-8"));
    podsCache = data.pods ?? [];
    podsCacheTime = now;
  } catch {
    podsCache = [];
  }
  return podsCache;
}





function isSessionWorking(s: ClaudeSession): boolean {
  return (
    s.turnState === "working" ||
    (s.turnState === "unknown" && s.cpuPercent > ACTIVE_CPU_THRESHOLD)
  );
}

function resolveSessionLocation(
  session: ClaudeSession
): { workspace: number; tabTitle: string } | null {
  // Primary: look up pod state — CWD → workspace + tab title
  const pods = loadPods();
  for (const pod of pods) {
    if (pod.directory === session.cwd) {
      const basename = pod.directory.split("/").pop() ?? "";
      return { workspace: pod.workspace, tabTitle: basename };
    }
  }

  // Fallback: query yabai to find a Ghostty window matching this CWD
  try {
    const output = execSync("yabai -m query --windows 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const windows: YabaiWindow[] = JSON.parse(output);
    const ghostty = windows.filter((w) => w.app === "Ghostty");

    const cwdParts = session.cwd.split("/");
    const basename = cwdParts[cwdParts.length - 1] ?? "";
    const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, " ");
    const normBase = norm(basename);

    for (const w of ghostty) {
      if (norm(w.title) === normBase) {
        return { workspace: w.space, tabTitle: w.title };
      }
    }
    for (const w of ghostty) {
      const t = norm(w.title);
      if (normBase && (t.includes(normBase) || normBase.includes(t))) {
        return { workspace: w.space, tabTitle: w.title };
      }
    }
  } catch {}

  return null;
}

export function updateCompletedSessions(sessions: ClaudeSession[]): void {
  const interactive = sessions.filter((s) => !s.isSubagent);
  const currentlyActive = new Set(
    interactive.filter(isSessionWorking).map((s) => s.pid)
  );
  const alivePids = new Set(interactive.map((s) => s.pid));

  // === Detect crashed sessions (was working, PID gone) ===
  const crashedPids: number[] = [];
  for (const pid of previouslyActive) {
    if (!alivePids.has(pid)) {
      crashedPids.push(pid);
    }
  }

  // === Detect newly stalled sessions (API error, no response) ===
  const newlyStalled = interactive.filter(
    (s) => s.turnState === "stalled" && !alertedStalled.has(s.pid)
  );

  // === Detect normally completed sessions (exclude stalled) ===
  const newlyCompleted = interactive.filter(
    (s) => previouslyActive.has(s.pid) && !currentlyActive.has(s.pid) && s.turnState !== "stalled"
  );

  // === Handle normal completions ===
  if (newlyCompleted.length > 0) {
    const now = Date.now();

    for (const s of newlyCompleted) {
      const location = resolveSessionLocation(s);
      const existing = completedQueue.findIndex((c) => c.pid === s.pid);
      if (existing !== -1) completedQueue.splice(existing, 1);

      completedQueue.unshift({
        pid: s.pid,
        cwd: s.cwd,
        completedAt: now,
        workspace: location?.workspace ?? null,
        tabTitle: location?.tabTitle ?? null,
      });
    }

    while (completedQueue.length > 50) completedQueue.pop();
    cursor = -1;
  }

  // === Handle errors (crashes + stalls) ===
  if (crashedPids.length > 0 || newlyStalled.length > 0) {
    for (const s of newlyStalled) alertedStalled.add(s.pid);
  }

  // === Clean up alertedStalled (session recovered or gone) ===
  for (const pid of alertedStalled) {
    const session = interactive.find((s) => s.pid === pid);
    if (!session || session.turnState !== "stalled") {
      alertedStalled.delete(pid);
    }
  }

  // === Remove dead PIDs from completed queue ===
  for (let i = completedQueue.length - 1; i >= 0; i--) {
    if (!alivePids.has(completedQueue[i].pid)) {
      completedQueue.splice(i, 1);
    }
  }

  // === Update workspace info for working sessions (resolve only new ones) ===
  for (const s of interactive.filter(isSessionWorking)) {
    if (!previousWorkingInfo.has(s.pid)) {
      const location = resolveSessionLocation(s);
      previousWorkingInfo.set(s.pid, {
        workspace: location?.workspace ?? null,
        tabTitle: location?.tabTitle ?? null,
      });
    }
  }
  // Clean up info for sessions no longer working (keep crashed until handled)
  for (const pid of previousWorkingInfo.keys()) {
    if (!currentlyActive.has(pid) && !crashedPids.includes(pid)) {
      previousWorkingInfo.delete(pid);
    }
  }
  for (const pid of crashedPids) {
    previousWorkingInfo.delete(pid);
  }

  previouslyActive = currentlyActive;
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
  } catch {}
}

export function getCompletedQueue(): CompletedSession[] {
  return completedQueue;
}

export function getActiveCount(sessions: ClaudeSession[]): number {
  return sessions.filter((s) => !s.isSubagent && isSessionWorking(s)).length;
}

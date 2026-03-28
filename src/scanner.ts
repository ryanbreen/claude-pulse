import { execSync } from "child_process";
import {
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// CPU threshold kept as a secondary signal for display (dot color, sparklines).
// Primary "working" detection uses JSONL turn state, not CPU.
export const ACTIVE_CPU_THRESHOLD = 3.0;

// Caches to avoid re-reading unchanged files every 3s poll cycle.
// Without caching, 18 sessions × 128KB reads × JSON.parse every 3s
// fragments V8's heap until OOM after ~20 hours.
// Cache stores parsed JSONL timestamps, NOT derived state.
// State is re-derived each call using timestamps + CPU so it responds
// to process activity changes without needing a file modification.
interface TurnCacheEntry {
  mtimeMs: number;
  lastHumanMessageTs: number;
  lastAssistantAnyTs: number; // any assistant entry (text or tool_use)
  lastTurnEndTs: number;
  lastToolUseTs: number;      // last assistant tool_use
  lastToolResultTs: number;   // last user tool_result
}
const turnStateCache = new Map<string, TurnCacheEntry>();
let historyCache: {
  mtimeMs: number;
  size: number;
  allEntries: HistoryEntry[];
} | null = null;

export type TurnState = "working" | "idle" | "stalled" | "unknown";

export interface ClaudeSession {
  pid: number;
  ppid: number;
  tty: string;
  elapsed: string;
  elapsedSeconds: number;
  cpuPercent: number;
  rssMB: number;
  command: string;
  cwd: string;
  flags: string[];
  sessionId?: string;
  isSubagent: boolean;
  turnState: TurnState;
}

export interface HistoryEntry {
  display?: string;
  timestamp: number;
  project?: string;
  sessionId?: string;
}

function parseElapsed(elapsed: string): number {
  // Formats: MM:SS, HH:MM:SS, D-HH:MM:SS, DD-HH:MM:SS
  elapsed = elapsed.trim();
  const dayMatch = elapsed.match(/^(\d+)-(.+)$/);
  let days = 0;
  let rest = elapsed;
  if (dayMatch) {
    days = parseInt(dayMatch[1]);
    rest = dayMatch[2];
  }
  const parts = rest.split(":").map(Number);
  if (parts.length === 2) {
    return days * 86400 + parts[0] * 60 + parts[1];
  }
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Determine if a session is mid-turn by reading the tail of its JSONL transcript.
 *
 * The cache stores only parsed timestamps (not derived state) so that state
 * can be re-derived each call using timestamps + CPU. This avoids both:
 * - Re-reading 128KB of JSONL every 3s (OOM after 20h)
 * - Stale cached state that never detects API errors
 *
 * cpuPercent gates the time-based heuristics: a session with high CPU is
 * still working even if the JSONL hasn't been updated (long tool execution).
 */
function detectTurnState(cwd: string, sessionId: string | undefined, cpuPercent: number): TurnState {
  const home = homedir();
  const projectsDir = join(home, ".claude", "projects");
  const projectDirName = cwd.replace(/\//g, "-");
  const projectPath = join(projectsDir, projectDirName);

  if (!existsSync(projectPath)) return "unknown";

  let jsonlPath: string | null = null;

  if (sessionId) {
    const candidate = join(projectPath, `${sessionId}.jsonl`);
    if (existsSync(candidate)) jsonlPath = candidate;
  }

  if (!jsonlPath) {
    try {
      const entries = readdirSync(projectPath)
        .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
        .map((f) => ({
          name: f,
          mtime: statSync(join(projectPath, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      if (entries.length > 0) {
        jsonlPath = join(projectPath, entries[0].name);
      }
    } catch {
      return "unknown";
    }
  }

  if (!jsonlPath) return "unknown";

  try {
    const fileStat = statSync(jsonlPath);
    let entry: TurnCacheEntry;

    const cached = turnStateCache.get(jsonlPath);
    if (cached && cached.mtimeMs === fileStat.mtimeMs) {
      entry = cached;
    } else {
      entry = parseTurnTimestamps(jsonlPath, fileStat);
      turnStateCache.set(jsonlPath, entry);

      if (turnStateCache.size > 100) {
        const first = turnStateCache.keys().next().value;
        if (first) turnStateCache.delete(first);
      }
    }

    return deriveTurnState(entry, cpuPercent);
  } catch {
    return "unknown";
  }
}

/** Parse JSONL tail and extract the timestamps needed for turn state detection. */
function parseTurnTimestamps(jsonlPath: string, fileStat: { size: number; mtimeMs: number }): TurnCacheEntry {
  const fd = openSync(jsonlPath, "r");
  const readSize = Math.min(fileStat.size, 131072);
  const buffer = Buffer.alloc(readSize);
  readSync(fd, buffer, 0, readSize, Math.max(0, fileStat.size - readSize));
  closeSync(fd);

  const tail = buffer.toString("utf-8");
  const lines = tail.split("\n").filter((l) => l.trim());

  let lastTurnEndTs = 0;
  let lastHumanMessageTs = 0;
  let lastAssistantAnyTs = 0;
  let lastToolUseTs = 0;
  let lastToolResultTs = 0;

  for (const line of lines) {
    try {
      if (line.length > 4096) {
        const typeMatch = line.match(/^\{"type":"(\w+)"/);
        if (!typeMatch) continue;
        const type = typeMatch[1];
        const tsMatch = line.match(/"timestamp":"([^"]+)"/);
        const ts = tsMatch ? new Date(tsMatch[1]).getTime() : 0;

        if (type === "system") {
          const d = JSON.parse(line);
          const sub = d.subtype;
          if (sub === "turn_duration" || sub === "stop_hook_summary") {
            if (ts > lastTurnEndTs) lastTurnEndTs = ts;
          }
        } else if (type === "assistant") {
          if (ts > lastAssistantAnyTs) lastAssistantAnyTs = ts;
          if (line.includes('"tool_use"') && ts > lastToolUseTs) lastToolUseTs = ts;
        } else if (type === "user") {
          if (line.includes("tool_result")) {
            if (ts > lastToolResultTs) lastToolResultTs = ts;
            continue;
          }
          if (
            line.includes("<local-command-") ||
            line.includes("[Request interrupted by user]")
          )
            continue;
          if (ts > lastHumanMessageTs) lastHumanMessageTs = ts;
        }
        continue;
      }

      const d = JSON.parse(line);
      const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;

      if (d.type === "system") {
        const sub = d.subtype;
        if (sub === "turn_duration" || sub === "stop_hook_summary") {
          if (ts > lastTurnEndTs) lastTurnEndTs = ts;
        }
      }

      if (d.type === "assistant") {
        if (ts > lastAssistantAnyTs) lastAssistantAnyTs = ts;
        const content = d.message?.content;
        if (Array.isArray(content)) {
          if (content.some((c: any) => c.type === "tool_use") && ts > lastToolUseTs)
            lastToolUseTs = ts;
        }
      }

      if (d.type === "user") {
        const content = d.message?.content;
        // Track tool results separately (not human messages)
        if (Array.isArray(content) && content.some((c: any) => c.type === "tool_result")) {
          if (ts > lastToolResultTs) lastToolResultTs = ts;
          continue;
        }
        if (typeof content === "string" && content.includes("tool_result")) {
          if (ts > lastToolResultTs) lastToolResultTs = ts;
          continue;
        }
        const isNonPrompt = (s: string) =>
          s.includes("<local-command-") ||
          s.includes("<command-name>") ||
          s.includes("[Request interrupted by user]");
        if (typeof content === "string" && content.length > 0) {
          if (!isNonPrompt(content) && ts > lastHumanMessageTs)
            lastHumanMessageTs = ts;
        } else if (Array.isArray(content)) {
          const hasHumanText = content.some(
            (c: any) =>
              c.type === "text" &&
              c.text?.length > 0 &&
              !isNonPrompt(c.text)
          );
          if (hasHumanText && ts > lastHumanMessageTs)
            lastHumanMessageTs = ts;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return {
    mtimeMs: fileStat.mtimeMs,
    lastHumanMessageTs,
    lastAssistantAnyTs,
    lastTurnEndTs,
    lastToolUseTs,
    lastToolResultTs,
  };
}

/**
 * Derive turn state from cached timestamps + live CPU.
 *
 * Key rules:
 * - Tool pending (tool_use without tool_result) → always working
 * - turn_duration after last human message → idle
 * - Human message with no response for 30s + low CPU → stalled
 * - Human message with response but no turn_duration for 30s + low CPU → idle
 * - Otherwise → working
 */
function deriveTurnState(e: TurnCacheEntry, cpuPercent: number): TurnState {
  if (e.lastHumanMessageTs === 0 && e.lastTurnEndTs === 0) return "unknown";

  // Turn completed normally
  if (e.lastTurnEndTs >= e.lastHumanMessageTs) return "idle";

  // Human message is newer than last turn end — mid-turn or stalled.

  // If a tool_use was sent with no tool_result yet, a tool is executing.
  // The session is working regardless of CPU or elapsed time.
  if (e.lastToolUseTs > e.lastToolResultTs && e.lastToolUseTs > e.lastTurnEndTs) {
    return "working";
  }

  // Only apply time-based downgrades when the process is idle.
  // During tool execution the Claude process itself may be at 0% CPU
  // while the child process does the work — but that's caught above
  // by the tool-pending check.
  const processIdle = cpuPercent < ACTIVE_CPU_THRESHOLD;

  // Claude responded (any entry) after the human message, but no turn_duration.
  // If >30s and process idle, the turn probably completed without system entries.
  if (
    e.lastAssistantAnyTs > e.lastHumanMessageTs &&
    Date.now() - e.lastAssistantAnyTs > 30_000 &&
    processIdle
  ) {
    return "idle";
  }

  // No assistant response at all after the human message.
  // If >30s and process idle, Claude likely hit an API error.
  if (
    e.lastAssistantAnyTs <= e.lastHumanMessageTs &&
    Date.now() - e.lastHumanMessageTs > 30_000 &&
    processIdle
  ) {
    return "stalled";
  }

  return "working";
}

function batchGetCwd(pids: number[]): Map<number, string> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  try {
    // lsof -p accepts comma-separated PIDs with -a -d cwd to get only cwd entries
    const pidList = pids.join(",");
    const output = execSync(
      `lsof -a -d cwd -p ${pidList} -F pn 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    );

    let currentPid = 0;
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = parseInt(line.slice(1));
      } else if (line.startsWith("n") && currentPid) {
        result.set(currentPid, line.slice(1));
      }
    }
  } catch {
    // fallback: no cwd info
  }

  return result;
}

export function getActiveSessions(): ClaudeSession[] {
  try {
    const psOutput = execSync(
      `ps -eo pid,ppid,tty,etime,%cpu,rss,command 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    );

    const sessions: ClaudeSession[] = [];
    const claudePids = new Set<number>();

    const lines = psOutput.trim().split("\n");

    // Build PID→PPID map from ALL processes so we can walk the tree
    // to detect subagents spawned through shell intermediaries
    const allPidToPpid = new Map<number, number>();
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(\d+)/);
      if (m) allPidToPpid.set(parseInt(m[1]), parseInt(m[2]));
    }

    // First pass: collect all claude PIDs
    for (const line of lines) {
      if (!line.includes("claude") || !line.includes("--")) continue;
      if (line.includes("/bin/sh") || line.includes("/bin/zsh")) continue;
      if (line.includes("grep")) continue;

      const match = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+([\w?/]+)\s+([\d:.+-]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/
        );
      if (!match) continue;
      const command = match[7].trim();
      if (!command.match(/\bclaude\s+--/)) continue;
      claudePids.add(parseInt(match[1]));
    }

    // Walk up the process tree to find a Claude ancestor (handles /bin/sh intermediaries)
    function hasClaudeAncestor(pid: number): boolean {
      let current = allPidToPpid.get(pid);
      for (let depth = 0; current !== undefined && depth < 3; depth++) {
        if (claudePids.has(current)) return true;
        current = allPidToPpid.get(current);
      }
      return false;
    }

    // Second pass: build sessions, detecting subagents
    for (const line of lines) {
      if (!line.includes("claude") || !line.includes("--")) continue;
      if (line.includes("/bin/sh") || line.includes("/bin/zsh")) continue;
      if (line.includes("grep")) continue;

      const match = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+([\w?/]+)\s+([\d:.+-]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/
        );
      if (!match) continue;

      const command = match[7].trim();
      if (!command.match(/\bclaude\s+--/)) continue;

      const pid = parseInt(match[1]);
      const ppid = parseInt(match[2]);

      // Skip our own parent process
      if (pid === process.ppid) continue;

      const flags: string[] = [];
      if (command.includes("--continue")) flags.push("continue");
      if (command.includes("--resume")) flags.push("resume");

      const sidMatch = command.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
      );

      // Subagent if: ancestor is Claude (handles /bin/sh intermediaries),
      // or running in non-interactive --print mode
      const isSubagent = hasClaudeAncestor(pid) || command.includes("--print");

      sessions.push({
        pid,
        ppid,
        tty: match[3],
        elapsed: match[4].trim(),
        elapsedSeconds: parseElapsed(match[4]),
        cpuPercent: parseFloat(match[5]),
        rssMB: Math.round(parseInt(match[6]) / 1024),
        command,
        cwd: "unknown", // filled in below, then turnState resolved
        flags,
        sessionId: sidMatch ? sidMatch[1] : undefined,
        isSubagent,
        turnState: "unknown" as TurnState, // resolved after CWD is known
      });
    }

    // Batch resolve all cwds in a single lsof call
    const cwdMap = batchGetCwd(sessions.map((s) => s.pid));
    for (const s of sessions) {
      s.cwd = cwdMap.get(s.pid) ?? "unknown";
    }

    // Resolve turn state from JSONL transcripts (only for interactive sessions)
    for (const s of sessions) {
      if (!s.isSubagent && s.cwd !== "unknown") {
        s.turnState = detectTurnState(s.cwd, s.sessionId, s.cpuPercent);
      }
    }

    return sessions.sort((a, b) => b.cpuPercent - a.cpuPercent);
  } catch {
    return [];
  }
}

export function getRecentHistory(hours: number = 24): HistoryEntry[] {
  const historyPath = join(homedir(), ".claude", "history.jsonl");
  if (!existsSync(historyPath)) return [];

  try {
    // Check cache: skip re-reading if file hasn't changed
    const fileStat = statSync(historyPath);
    if (
      historyCache &&
      historyCache.mtimeMs === fileStat.mtimeMs &&
      historyCache.size === fileStat.size
    ) {
      const cutoff = Date.now() - hours * 3600 * 1000;
      return historyCache.allEntries.filter((e) => e.timestamp >= cutoff);
    }

    // Read only the tail of the file to avoid OOM on large history files.
    // 512KB is generous for 48h of history data.
    const fd = openSync(historyPath, "r");
    const readSize = Math.min(fileStat.size, 524288);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, Math.max(0, fileStat.size - readSize));
    closeSync(fd);

    const content = buffer.toString("utf-8");
    const allEntries: HistoryEntry[] = [];

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        allEntries.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // skip malformed lines (including partial first line from tail read)
      }
    }

    historyCache = {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      allEntries,
    };

    const cutoff = Date.now() - hours * 3600 * 1000;
    return allEntries.filter((e) => e.timestamp >= cutoff);
  } catch {
    return [];
  }
}

export interface PeakActivity {
  count: number;
  hour: number;
  minute: number;
  label: string;
}

export function getPeakConcurrent(history: HistoryEntry[]): PeakActivity {
  // Count unique sessions per 20-min bucket to find peak concurrency
  const bucketSessions = new Map<number, Set<string>>();

  for (const entry of history) {
    if (!entry.sessionId) continue;
    const d = new Date(entry.timestamp);
    const bucket = d.getHours() * 3 + Math.floor(d.getMinutes() / 20);
    let set = bucketSessions.get(bucket);
    if (!set) {
      set = new Set();
      bucketSessions.set(bucket, set);
    }
    set.add(entry.sessionId);
  }

  let peakBucket = 0;
  let peakCount = 0;
  for (const [bucket, sessions] of bucketSessions) {
    if (sessions.size > peakCount) {
      peakCount = sessions.size;
      peakBucket = bucket;
    }
  }

  const hour = Math.floor(peakBucket / 3);
  const minute = (peakBucket % 3) * 20;
  const period = hour >= 12 ? "pm" : "am";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const label = `${h12}:${String(minute).padStart(2, "0")}${period}`;

  return { count: peakCount, hour, minute, label };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function shortenPath(p: string, maxLen: number = 45): string {
  const home = homedir();
  if (p.startsWith(home)) {
    p = "~" + p.slice(home.length);
  }
  if (p.length <= maxLen) return p;
  // Keep first segment and last 2 segments
  const parts = p.split("/");
  if (parts.length > 3) {
    const short = parts[0] + "/.../" + parts.slice(-2).join("/");
    if (short.length <= maxLen) return short;
    return parts[0] + "/.../" + parts[parts.length - 1];
  }
  return p;
}

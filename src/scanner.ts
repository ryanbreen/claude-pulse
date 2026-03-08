import { execSync } from "child_process";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// CPU threshold kept as a secondary signal for display (dot color, sparklines).
// Primary "working" detection uses JSONL turn state, not CPU.
export const ACTIVE_CPU_THRESHOLD = 3.0;

export type TurnState = "working" | "idle" | "unknown";

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
 * State machine:
 *   - Last meaningful entry is `system` with `subtype: "turn_duration"` → idle
 *   - A `user` entry with text content (not tool_result) after the last turn_duration → working
 *   - Otherwise → unknown
 *
 * We read the last ~8KB of the file to find the most recent turn boundary.
 */
function detectTurnState(cwd: string, sessionId?: string): TurnState {
  const home = homedir();
  const projectsDir = join(home, ".claude", "projects");

  // Convert CWD to the project directory name Claude uses:
  // /Users/wrb/fun/code/claude-pulse → -Users-wrb-fun-code-claude-pulse
  const projectDirName = cwd.replace(/\//g, "-");
  const projectPath = join(projectsDir, projectDirName);

  if (!existsSync(projectPath)) return "unknown";

  // Find the right JSONL — if we have a session ID, use it directly.
  // Otherwise, use the most recently modified JSONL in the project dir.
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
    // Read last ~16KB for enough context to find the turn boundary
    const fd = openSync(jsonlPath, "r");
    const stat = fstatSync(fd);
    const readSize = Math.min(stat.size, 16384);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    closeSync(fd);

    const tail = buffer.toString("utf-8");
    const lines = tail.split("\n").filter((l) => l.trim());

    // Scan for the decisive signals:
    // - system/turn_duration or system/stop_hook_summary = turn complete (idle)
    // - user with text content (not tool_result) = human sent message (working)
    // - assistant with text as final entry + stale = turn complete but system entries missing
    let lastTurnEndTs = 0;
    let lastHumanMessageTs = 0;
    let lastAssistantTextTs = 0;

    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;

        if (d.type === "system") {
          const sub = d.subtype;
          if (sub === "turn_duration" || sub === "stop_hook_summary") {
            if (ts > lastTurnEndTs) lastTurnEndTs = ts;
          }
        }

        if (d.type === "assistant") {
          const content = d.message?.content;
          if (Array.isArray(content)) {
            const hasText = content.some((c: any) => c.type === "text");
            if (hasText && ts > lastAssistantTextTs) lastAssistantTextTs = ts;
          }
        }

        if (d.type === "user") {
          const content = d.message?.content;
          // Distinguish human text from automatic tool_result and local commands.
          // Local commands (e.g. /login) write user entries with <local-command-*>
          // or <command-name> tags — these don't trigger a Claude turn.
          const isLocalCmd = (s: string) =>
            s.includes("<local-command-") || s.includes("<command-name>");
          if (typeof content === "string" && content.length > 0) {
            if (!isLocalCmd(content) && ts > lastHumanMessageTs)
              lastHumanMessageTs = ts;
          } else if (Array.isArray(content)) {
            const hasHumanText = content.some(
              (c: any) =>
                c.type === "text" &&
                c.text?.length > 0 &&
                !isLocalCmd(c.text)
            );
            if (hasHumanText) {
              if (ts > lastHumanMessageTs) lastHumanMessageTs = ts;
            }
          }
        }
      } catch {
        // skip malformed lines (e.g., partial line at start of buffer)
      }
    }

    if (lastHumanMessageTs === 0 && lastTurnEndTs === 0) return "unknown";
    if (lastHumanMessageTs > lastTurnEndTs) {
      // Human message is newer than last turn end — but check for stale turns.
      // If Claude's last text response is after the human message and >30s old,
      // the turn is done but system entries were never written (crash/Ctrl-C).
      if (
        lastAssistantTextTs > lastHumanMessageTs &&
        Date.now() - lastAssistantTextTs > 30_000
      ) {
        return "idle";
      }
      return "working";
    }
    return "idle";
  } catch {
    return "unknown";
  }
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
    // Collect all claude PIDs first so we can identify subagents
    const claudePids = new Set<number>();

    const lines = psOutput.trim().split("\n");
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

      // A subagent's parent (or grandparent via /bin/sh) is another claude process
      const isSubagent = claudePids.has(ppid);

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
        s.turnState = detectTurnState(s.cwd, s.sessionId);
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
    // Read only the tail of the file to avoid OOM on large history files.
    // 512KB is generous for 48h of history data.
    const fd = openSync(historyPath, "r");
    const stat = fstatSync(fd);
    const readSize = Math.min(stat.size, 524288);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
    closeSync(fd);

    const content = buffer.toString("utf-8");
    const cutoff = Date.now() - hours * 3600 * 1000;
    const entries: HistoryEntry[] = [];

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.timestamp >= cutoff) {
          entries.push(entry);
        }
      } catch {
        // skip malformed lines (including partial first line from tail read)
      }
    }

    return entries;
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

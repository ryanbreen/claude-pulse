import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
        cwd: "unknown",
        flags,
        sessionId: sidMatch ? sidMatch[1] : undefined,
        isSubagent,
      });
    }

    // Batch resolve all cwds in a single lsof call
    const cwdMap = batchGetCwd(sessions.map((s) => s.pid));
    for (const s of sessions) {
      s.cwd = cwdMap.get(s.pid) ?? "unknown";
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
    const content = readFileSync(historyPath, "utf-8");
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
        // skip malformed lines
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

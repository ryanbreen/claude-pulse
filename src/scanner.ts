import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ClaudeSession {
  pid: number;
  tty: string;
  elapsed: string;
  elapsedSeconds: number;
  cpuPercent: number;
  rssMB: number;
  command: string;
  cwd: string;
  flags: string[];
  sessionId?: string;
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
    // Two-step: first find PIDs, then get details
    const psOutput = execSync(
      `ps -eo pid,tty,etime,%cpu,rss,command 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    );

    const sessions: ClaudeSession[] = [];
    for (const line of psOutput.trim().split("\n")) {
      // Match lines where command is the claude binary (not /bin/sh wrapper)
      if (!line.includes("claude") || !line.includes("--")) continue;
      if (line.includes("/bin/sh") || line.includes("/bin/zsh")) continue;
      if (line.includes("grep")) continue;

      const match = line
        .trim()
        .match(
          /^(\d+)\s+([\w?/]+)\s+([\d:.+-]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/
        );
      if (!match) continue;

      const command = match[6].trim();
      // Only match actual claude CLI invocations
      if (!command.match(/\bclaude\s+--/)) continue;

      const pid = parseInt(match[1]);

      // Skip our own parent process
      if (pid === process.ppid) continue;

      const flags: string[] = [];
      if (command.includes("--continue")) flags.push("continue");
      if (command.includes("--resume")) flags.push("resume");

      const sidMatch = command.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/
      );

      sessions.push({
        pid,
        tty: match[2],
        elapsed: match[3].trim(),
        elapsedSeconds: parseElapsed(match[3]),
        cpuPercent: parseFloat(match[4]),
        rssMB: Math.round(parseInt(match[5]) / 1024),
        command,
        cwd: "unknown", // filled in below
        flags,
        sessionId: sidMatch ? sidMatch[1] : undefined,
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

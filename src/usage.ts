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

export interface UsageInfo {
  fiveHourTokens: number;
  weeklyTokens: number;
  fiveHourPct: number;
  weeklyPct: number;
  fiveHourResetMs: number;
  weeklyResetMs: number;
}

// Configurable via env vars. Set to 0 to disable that limit display.
// Read lazily so env vars can be set after import (e.g., .env loading).
function getFiveHourLimit(): number {
  return parseInt(process.env.CLAUDE_PULSE_5H_LIMIT ?? "0", 10);
}
function getWeeklyLimit(): number {
  return parseInt(process.env.CLAUDE_PULSE_WEEKLY_LIMIT ?? "0", 10);
}

interface TokenEntry {
  ts: number;
  tokens: number; // input + cache_creation + output (what counts toward limits)
}

// Cache per JSONL file: only re-read when mtime changes
const fileCache = new Map<
  string,
  { mtimeMs: number; entries: TokenEntry[] }
>();

// Oldest timestamp we care about for cache eviction
let oldestRelevant = 0;

export function getUsageInfo(): UsageInfo | null {
  if (!getFiveHourLimit() && !getWeeklyLimit()) return null;

  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  const now = Date.now();
  const fiveHoursAgo = now - 5 * 3600_000;
  const weekAgo = now - 7 * 24 * 3600_000;
  oldestRelevant = weekAgo;

  let fiveHourTokens = 0;
  let weeklyTokens = 0;
  let earliestFiveHour = now;

  try {
    const projects = readdirSync(projectsDir);
    for (const proj of projects) {
      const projPath = join(projectsDir, proj);
      let files: string[];
      try {
        files = readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }

      for (const f of files) {
        const fpath = join(projPath, f);
        let stat;
        try {
          stat = statSync(fpath);
        } catch {
          continue;
        }

        // Skip files not modified in the relevant window
        if (stat.mtimeMs < weekAgo) continue;

        // Check cache
        const cached = fileCache.get(fpath);
        let entries: TokenEntry[];

        if (cached && cached.mtimeMs === stat.mtimeMs) {
          entries = cached.entries;
        } else {
          entries = extractTokens(fpath, stat.size);
          fileCache.set(fpath, { mtimeMs: stat.mtimeMs, entries });
        }

        for (const e of entries) {
          if (e.ts >= weekAgo) {
            weeklyTokens += e.tokens;
            if (e.ts >= fiveHoursAgo) {
              fiveHourTokens += e.tokens;
              if (e.ts < earliestFiveHour) earliestFiveHour = e.ts;
            }
          }
        }
      }
    }
  } catch {
    return null;
  }

  // Prune stale cache entries periodically
  if (fileCache.size > 500) {
    for (const [k, v] of fileCache) {
      if (v.entries.length === 0 || v.entries[v.entries.length - 1].ts < weekAgo) {
        fileCache.delete(k);
      }
    }
  }

  // 5-hour rolling window: oldest entry falls off at its ts + 5h
  const fiveHourResetMs = earliestFiveHour < now
    ? earliestFiveHour + 5 * 3600_000
    : now + 5 * 3600_000;

  // Weekly: 7 days from now (rolling)
  const weeklyResetMs = now + 7 * 24 * 3600_000;

  return {
    fiveHourTokens,
    weeklyTokens,
    fiveHourPct: getFiveHourLimit()
      ? Math.min(Math.round((fiveHourTokens / getFiveHourLimit()) * 100), 100)
      : 0,
    weeklyPct: getWeeklyLimit()
      ? Math.min(Math.round((weeklyTokens / getWeeklyLimit()) * 100), 100)
      : 0,
    fiveHourResetMs,
    weeklyResetMs,
  };
}

function extractTokens(path: string, fileSize: number): TokenEntry[] {
  const entries: TokenEntry[] = [];

  try {
    // Read up to 1MB tail — covers several days of typical session activity
    const readSize = Math.min(fileSize, 1024 * 1024);
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, Math.max(0, fileSize - readSize));
    closeSync(fd);

    const content = buffer.toString("utf-8");

    // Only process assistant-type entries that have output_tokens > 0
    // (these are the actual API calls, not streaming progress chunks)
    for (const line of content.split("\n")) {
      if (!line.includes('"type":"assistant"')) continue;
      if (!line.includes('"output_tokens"')) continue;

      // Use regex extraction to avoid JSON.parse on potentially huge lines
      const tsMatch = line.match(/"timestamp":"([^"]+)"/);
      if (!tsMatch) continue;
      const ts = new Date(tsMatch[1]).getTime();
      if (ts < oldestRelevant) continue;

      const inputMatch = line.match(/"input_tokens":(\d+)/);
      const cacheCreateMatch = line.match(
        /"cache_creation_input_tokens":(\d+)/
      );
      const outputMatch = line.match(/"output_tokens":(\d+)/);

      if (!outputMatch) continue;
      const output = parseInt(outputMatch[1], 10);
      // Skip streaming progress entries (output_tokens <= 1)
      if (output <= 1) continue;

      const input = (inputMatch ? parseInt(inputMatch[1], 10) : 0) +
        (cacheCreateMatch ? parseInt(cacheCreateMatch[1], 10) : 0);

      entries.push({ ts, tokens: input + output });
    }
  } catch {
    // skip unreadable files
  }

  return entries;
}

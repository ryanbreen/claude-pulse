import {
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

export interface UsageInfo {
  // Claude usage
  fiveHourTokens: number;
  weeklyTokens: number;
  fiveHourPct: number;
  weeklyPct: number;
  fiveHourResetMs: number;
  weeklyResetMs: number;
  // Codex usage
  codexWeeklyTokens: number;
  codexWeeklyPct: number;
  // User identity
  claudeEmail: string | null;
}

// Configurable via env vars. Set to 0 to disable.
function getFiveHourLimit(): number {
  return parseInt(process.env.CLAUDE_PULSE_5H_LIMIT ?? "0", 10);
}
function getWeeklyLimit(): number {
  return parseInt(process.env.CLAUDE_PULSE_WEEKLY_LIMIT ?? "0", 10);
}
function getCodexWeeklyLimit(): number {
  return parseInt(process.env.CLAUDE_PULSE_CODEX_WEEKLY_LIMIT ?? "0", 10);
}

interface TokenEntry {
  ts: number;
  tokens: number;
}

// Cache per JSONL file: only re-read when mtime changes
const fileCache = new Map<
  string,
  { mtimeMs: number; entries: TokenEntry[] }
>();

let oldestRelevant = 0;

// Claude auth email — cached since it rarely changes
let cachedEmail: string | null | undefined = undefined;
let emailFetchedAt = 0;
const EMAIL_CACHE_MS = 5 * 60_000; // re-check every 5 min

function getClaudeEmail(): string | null {
  const now = Date.now();
  if (cachedEmail !== undefined && now - emailFetchedAt < EMAIL_CACHE_MS) {
    return cachedEmail;
  }
  try {
    const output = execSync("claude auth status 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const match = output.match(/"email"\s*:\s*"([^"]+)"/);
    cachedEmail = match ? match[1] : null;
  } catch {
    cachedEmail = null;
  }
  emailFetchedAt = now;
  return cachedEmail;
}

// Codex usage from SQLite — cached by db mtime
let codexCache: { mtimeMs: number; weeklyTokens: number } | null = null;

function getCodexWeeklyTokens(): number {
  const dbPath = join(homedir(), ".codex", "state_5.sqlite");
  if (!existsSync(dbPath)) return 0;

  try {
    const stat = statSync(dbPath);
    if (codexCache && codexCache.mtimeMs === stat.mtimeMs) {
      return codexCache.weeklyTokens;
    }

    const output = execSync(
      `sqlite3 "${dbPath}" "SELECT COALESCE(SUM(tokens_used),0) FROM threads WHERE created_at > unixepoch('now', '-7 days')"`,
      { encoding: "utf-8", timeout: 3000 }
    );
    const tokens = parseInt(output.trim(), 10) || 0;
    codexCache = { mtimeMs: stat.mtimeMs, weeklyTokens: tokens };
    return tokens;
  } catch {
    return 0;
  }
}

export function getUsageInfo(): UsageInfo | null {
  const has5h = getFiveHourLimit() > 0;
  const hasWeekly = getWeeklyLimit() > 0;
  const hasCodex = getCodexWeeklyLimit() > 0;

  if (!has5h && !hasWeekly && !hasCodex) return null;

  const projectsDir = join(homedir(), ".claude", "projects");
  const now = Date.now();
  const fiveHoursAgo = now - 5 * 3600_000;
  const weekAgo = now - 7 * 24 * 3600_000;
  oldestRelevant = weekAgo;

  let fiveHourTokens = 0;
  let weeklyTokens = 0;
  let earliestFiveHour = now;

  if ((has5h || hasWeekly) && existsSync(projectsDir)) {
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

          if (stat.mtimeMs < weekAgo) continue;

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
      // continue with zeros
    }
  }

  // Prune stale cache entries
  if (fileCache.size > 500) {
    for (const [k, v] of fileCache) {
      if (v.entries.length === 0 || v.entries[v.entries.length - 1].ts < weekAgo) {
        fileCache.delete(k);
      }
    }
  }

  const fiveHourResetMs = earliestFiveHour < now
    ? earliestFiveHour + 5 * 3600_000
    : now + 5 * 3600_000;
  const weeklyResetMs = now + 7 * 24 * 3600_000;

  // Codex
  const codexWeeklyTokens = hasCodex ? getCodexWeeklyTokens() : 0;

  // Only fetch email when any limit is approaching 80%
  const fiveHourPct = has5h
    ? Math.min(Math.round((fiveHourTokens / getFiveHourLimit()) * 100), 100)
    : 0;
  const weeklyPct = hasWeekly
    ? Math.min(Math.round((weeklyTokens / getWeeklyLimit()) * 100), 100)
    : 0;
  const codexWeeklyPct = hasCodex
    ? Math.min(Math.round((codexWeeklyTokens / getCodexWeeklyLimit()) * 100), 100)
    : 0;

  const anyApproaching = fiveHourPct >= 80 || weeklyPct >= 80 || codexWeeklyPct >= 80;
  const claudeEmail = anyApproaching ? getClaudeEmail() : null;

  return {
    fiveHourTokens,
    weeklyTokens,
    fiveHourPct,
    weeklyPct,
    fiveHourResetMs,
    weeklyResetMs,
    codexWeeklyTokens,
    codexWeeklyPct,
    claudeEmail,
  };
}

function extractTokens(path: string, fileSize: number): TokenEntry[] {
  const entries: TokenEntry[] = [];

  try {
    const readSize = Math.min(fileSize, 1024 * 1024);
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, Math.max(0, fileSize - readSize));
    closeSync(fd);

    const content = buffer.toString("utf-8");

    for (const line of content.split("\n")) {
      if (!line.includes('"type":"assistant"')) continue;
      if (!line.includes('"output_tokens"')) continue;

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

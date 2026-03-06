import { getActiveSessions, type ClaudeSession } from "./scanner.js";

const API_URL =
  process.env.CLAUDE_PULSE_API_URL ??
  "https://claude-pulse-api.porivo.workers.dev";
const API_KEY = process.env.CLAUDE_PULSE_API_KEY ?? "";

export interface ReportStatus {
  enabled: boolean;
  lastSent: number | null;
  lastError: string | null;
  totalSent: number;
  totalErrors: number;
}

const status: ReportStatus = {
  enabled: !!API_KEY,
  lastSent: null,
  lastError: null,
  totalSent: 0,
  totalErrors: 0,
};

export function getReportStatus(): ReportStatus {
  return { ...status };
}

export interface TrendBucket {
  bucket: number;
  peak_total: number;
  peak_active: number;
  avg_total: number;
  avg_cpu: number;
  peak_cpu: number;
  peak_mem_mb: number;
  sample_count: number;
}

export interface D1Stats {
  day: {
    peak_sessions: number;
    peak_active: number;
    avg_sessions: number;
    peak_cpu: number;
    peak_mem_mb: number;
    samples: number;
  };
  week: {
    peak_sessions: number;
    peak_active: number;
    avg_sessions: number;
    peak_cpu: number;
    peak_mem_mb: number;
    samples: number;
  };
  latest: { ts: number } | null;
}

export async function fetchTrends(hours = 24): Promise<TrendBucket[]> {
  if (!API_KEY) return [];
  try {
    const resp = await fetch(`${API_URL}/trends?hours=${hours}`, {
      headers: { "X-API-Key": API_KEY },
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { trends: TrendBucket[] };
    return body.trends ?? [];
  } catch {
    return [];
  }
}

export async function fetchStats(): Promise<D1Stats | null> {
  if (!API_KEY) return null;
  try {
    const resp = await fetch(`${API_URL}/stats`, {
      headers: { "X-API-Key": API_KEY },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as D1Stats;
  } catch {
    return null;
  }
}

export async function reportSnapshot(sessions?: ClaudeSession[]) {
  if (!API_KEY) return;

  const s = sessions ?? getActiveSessions();
  const interactive = s.filter((x) => !x.isSubagent);
  const active = interactive.filter((x) => x.cpuPercent > 0.5);
  const idle = interactive.filter((x) => x.cpuPercent <= 0.5);
  const totalCpu = s.reduce((sum, x) => sum + x.cpuPercent, 0);
  const totalMem = s.reduce((sum, x) => sum + x.rssMB, 0);
  const longest = interactive.reduce(
    (max, x) => (x.elapsedSeconds > max ? x.elapsedSeconds : max),
    0
  );

  const payload = {
    active_count: active.length,
    idle_count: idle.length,
    total_count: interactive.length,
    total_cpu: Math.round(totalCpu * 10) / 10,
    total_mem_mb: totalMem,
    longest_seconds: longest,
    sessions: s.map((x) => ({
      pid: x.pid,
      tty: x.tty,
      elapsed_seconds: x.elapsedSeconds,
      cpu_percent: x.cpuPercent,
      rss_mb: x.rssMB,
      cwd: x.cwd,
      flags: x.flags.join(","),
      session_id: x.sessionId ?? null,
    })),
  };

  try {
    const resp = await fetch(`${API_URL}/snapshot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const body = await resp.json();
    if (resp.ok) {
      status.lastSent = Date.now();
      status.totalSent++;
      status.lastError = null;
    } else {
      status.totalErrors++;
      status.lastError = (body as any)?.error ?? `HTTP ${resp.status}`;
    }
    return body;
  } catch (e: any) {
    status.totalErrors++;
    status.lastError = e.message ?? "network error";
  }
}

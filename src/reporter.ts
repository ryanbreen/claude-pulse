import { getActiveSessions, type ClaudeSession } from "./scanner.js";

const API_URL =
  process.env.CLAUDE_PULSE_API_URL ??
  "https://claude-pulse-api.porivo.workers.dev";
const API_KEY = process.env.CLAUDE_PULSE_API_KEY ?? "";

export async function reportSnapshot(sessions?: ClaudeSession[]) {
  if (!API_KEY) return;

  const s = sessions ?? getActiveSessions();
  const active = s.filter((x) => x.cpuPercent > 0.5);
  const idle = s.filter((x) => x.cpuPercent <= 0.5);
  const totalCpu = s.reduce((sum, x) => sum + x.cpuPercent, 0);
  const totalMem = s.reduce((sum, x) => sum + x.rssMB, 0);
  const longest = s.reduce(
    (max, x) => (x.elapsedSeconds > max ? x.elapsedSeconds : max),
    0
  );

  const payload = {
    active_count: active.length,
    idle_count: idle.length,
    total_count: s.length,
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
    return await resp.json();
  } catch {
    // silently fail - don't disrupt the TUI
  }
}

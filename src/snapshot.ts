import {
  getActiveSessions,
  getRecentHistory,
  getPeakConcurrent,
  formatDuration,
  shortenPath,
} from "./scanner.js";

const HEAT = ["·", "░", "▒", "▓", "█"];

export function renderSnapshot(): string {
  const sessions = getActiveSessions();
  const history = getRecentHistory(24);
  const active = sessions.filter((s) => s.cpuPercent > 0.5);
  const idle = sessions.filter((s) => s.cpuPercent <= 0.5);
  const totalMem = (
    sessions.reduce((s, c) => s + c.rssMB, 0) / 1024
  ).toFixed(1);
  const totalCpu = sessions.reduce((s, c) => s + c.cpuPercent, 0);
  const longest = sessions.reduce(
    (m, s) => (s.elapsedSeconds > m ? s.elapsedSeconds : m),
    0
  );
  const uniqueSessions = new Set(
    history.map((h) => h.sessionId).filter(Boolean)
  );
  const uniqueProjects = new Set(
    history.map((h) => h.project).filter(Boolean)
  );

  // Heatmap - 72 buckets (20-min intervals)
  const BUCKETS = 72;
  const buckets = new Array(BUCKETS).fill(0);
  for (const entry of history) {
    const d = new Date(entry.timestamp);
    const bucket = d.getHours() * 3 + Math.floor(d.getMinutes() / 20);
    buckets[bucket]++;
  }
  const heatMax = Math.max(...buckets, 1);
  const heatmap = buckets
    .map((c) => HEAT[Math.min(Math.floor((c / heatMax) * 4), 4)])
    .join("");
  const labels = new Array(BUCKETS).fill(" ");
  for (let h = 0; h < 24; h += 3) {
    const pos = h * 3;
    const lbl = String(h).padStart(2);
    labels[pos] = lbl[0];
    labels[pos + 1] = lbl[1];
  }

  const sep = "─".repeat(72);
  const lines: string[] = [];
  const time = new Date().toLocaleTimeString();

  lines.push(`  CLAUDE PULSE                        ${time}`);
  lines.push(sep);
  lines.push(
    `  ACTIVE: ${active.length}   IDLE: ${idle.length}   TOTAL: ${sessions.length}   CPU: ${totalCpu.toFixed(1)}%`
  );
  const peak = getPeakConcurrent(history);
  lines.push(
    `  MEMORY: ${totalMem} GB   LONGEST: ${formatDuration(longest)}   24H: ${uniqueSessions.size} sessions / ${uniqueProjects.size} projects   PEAK: ${peak.count} @ ${peak.label}`
  );
  lines.push(sep);
  lines.push(`  ${heatmap}`);
  lines.push(`  ${labels.join("")}`);
  lines.push(sep);

  if (sessions.length > 0) {
    lines.push(
      `  ${"".padEnd(2)}${"PID".padEnd(7)}${"TTY".padEnd(7)}${"UPTIME".padEnd(10)}${"CPU".padEnd(7)}${"MEM".padEnd(7)}${"MODE".padEnd(9)}DIRECTORY`
    );

    for (const s of sessions) {
      const dot = s.cpuPercent > 10 ? "⚡" : s.cpuPercent > 0.5 ? "● " : "○ ";
      const line =
        `  ${dot}` +
        `${String(s.pid).padEnd(7)}` +
        `${s.tty.replace("ttys", "s").padEnd(7)}` +
        `${formatDuration(s.elapsedSeconds).padEnd(10)}` +
        `${(s.cpuPercent.toFixed(1) + "%").padEnd(7)}` +
        `${(s.rssMB + "M").padEnd(7)}` +
        `${(s.flags.join(",") || "new").padEnd(9)}` +
        shortenPath(s.cwd, 30);
      lines.push(line);
    }
  } else {
    lines.push("  No active Claude sessions detected");
  }

  lines.push(sep);
  const dirs = new Set(sessions.map((s) => s.cwd));
  lines.push(
    `  ${sessions.length} sessions | ${dirs.size} projects | ${totalMem} GB`
  );

  return lines.join("\n");
}

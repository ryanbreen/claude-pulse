import {
  getActiveSessions,
  getRecentHistory,
  getPeakConcurrent,
  formatDuration,
  shortenPath,
  ACTIVE_CPU_THRESHOLD,
} from "./scanner.js";

const HEAT = ["·", "░", "▒", "▓", "█"];

export function renderSnapshot(): string {
  const W = process.stdout.columns || 120;
  const sessions = getActiveSessions();
  const history = getRecentHistory(24);
  const active = sessions.filter(
    (s) =>
      s.turnState === "working" ||
      (s.turnState === "unknown" && s.cpuPercent > ACTIVE_CPU_THRESHOLD)
  );
  const idle = sessions.filter(
    (s) =>
      s.turnState === "idle" ||
      (s.turnState === "unknown" && s.cpuPercent <= ACTIVE_CPU_THRESHOLD)
  );
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

  // Heatmap - scale to terminal width
  const heatWidth = W - 2;
  const minutesPerBucket = (24 * 60) / heatWidth;
  const buckets = new Array(heatWidth).fill(0);
  for (const entry of history) {
    const d = new Date(entry.timestamp);
    const bucket = Math.floor(
      (d.getHours() * 60 + d.getMinutes()) / minutesPerBucket
    );
    if (bucket < heatWidth) buckets[bucket]++;
  }
  const heatMax = Math.max(...buckets, 1);
  const heatmap = buckets
    .map((c) => HEAT[Math.min(Math.floor((c / heatMax) * 4), 4)])
    .join("");
  const labels = new Array(heatWidth).fill(" ");
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
    const pos = Math.floor((h * 60) / minutesPerBucket);
    if (pos + 1 < heatWidth) {
      const lbl = String(h).padStart(2);
      labels[pos] = lbl[0];
      labels[pos + 1] = lbl[1];
    }
  }

  const sep = "─".repeat(W);
  const lines: string[] = [];
  const time = new Date().toLocaleTimeString();
  const peak = getPeakConcurrent(history);

  // Fixed columns: dot(2) + PID(7) + TTY(7) + UPTIME(10) + CPU(7) + MEM(7) + MODE(9) = 49
  const dirWidth = Math.max(W - 51, 20);

  lines.push(
    `  CLAUDE PULSE${" ".repeat(Math.max(W - 14 - time.length - 2, 2))}${time}`
  );
  lines.push(sep);
  lines.push(
    `  ACTIVE: ${active.length}   IDLE: ${idle.length}   TOTAL: ${sessions.length}   CPU: ${totalCpu.toFixed(1)}%   MEMORY: ${totalMem} GB`
  );
  lines.push(
    `  LONGEST: ${formatDuration(longest)}   24H: ${uniqueSessions.size} sessions / ${uniqueProjects.size} projects   PEAK: ${peak.count} @ ${peak.label}`
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
      const isWorking =
        s.turnState === "working" ||
        (s.turnState === "unknown" && s.cpuPercent > ACTIVE_CPU_THRESHOLD);
      const dot = isWorking
        ? s.cpuPercent > 10
          ? "⚡"
          : "● "
        : "○ ";
      const line =
        `  ${dot}` +
        `${String(s.pid).padEnd(7)}` +
        `${s.tty.replace("ttys", "s").padEnd(7)}` +
        `${formatDuration(s.elapsedSeconds).padEnd(10)}` +
        `${(s.cpuPercent.toFixed(1) + "%").padEnd(7)}` +
        `${(s.rssMB + "M").padEnd(7)}` +
        `${(s.flags.join(",") || "new").padEnd(9)}` +
        shortenPath(s.cwd, dirWidth);
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

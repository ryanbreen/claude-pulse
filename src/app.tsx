import React, { useState, useEffect, useRef, useMemo } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import {
  getActiveSessions,
  getRecentHistory,
  getPeakConcurrent,
  formatDuration,
  shortenPath,
  ACTIVE_CPU_THRESHOLD,
  type ClaudeSession,
  type HistoryEntry,
  type PeakActivity,
  type TurnState,
} from "./scanner.js";
import {
  reportSnapshot,
  getReportStatus,
  fetchTrends,
  fetchStats,
  type TrendBucket,
  type D1Stats,
} from "./reporter.js";
import { updateCompletedSessions, getCompletedQueue } from "./state.js";
import { getUsageInfo, type UsageInfo } from "./usage.js";

const SPARK = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
const HEAT = ["\u00b7", "\u2591", "\u2592", "\u2593", "\u2588"];

// Memory safety constants — checked every 3s INSIDE the refresh callback
// (not a separate timer that can be starved by the event loop).
const HEAP_LIMIT_MB = 300;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours
const PROCESS_START = Date.now();

// ANSI escape codes — used to build colored strings directly instead of
// creating hundreds of React <Text> elements per render. Ink's reconciler
// leaks ~140 bytes per element per render cycle; with 100 sessions × 9
// elements each, that's 2MB/min. Pre-built ANSI strings bypass this.
const A = {
  R: "\x1b[0m",     // reset
  B: "\x1b[1m",     // bold
  D: "\x1b[2m",     // dim
  red: "\x1b[31m",
  grn: "\x1b[32m",
  yel: "\x1b[33m",
  blu: "\x1b[34m",
  mag: "\x1b[35m",
  cyn: "\x1b[36m",
  wht: "\x1b[37m",
  gry: "\x1b[90m",
} as const;

type TabMode = "live" | "history";

// Pre-computed digest replaces storing thousands of HistoryEntry objects in
// React state. Only small arrays of numbers and a few scalars — no object
// graphs for React/Ink to retain across double-buffered fiber trees.
interface HistoryDigest {
  todayMinutes: number[];       // 1440 per-minute activity counts for today
  yesterdayMinutes: number[];   // 1440 per-minute activity counts for yesterday
  uniqueProjectCount: number;
  uniqueSessionCount: number;
  peak: PeakActivity;
}

function computeHistoryDigest(entries: HistoryEntry[]): HistoryDigest {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const cutoff24h = Date.now() - 24 * 3600 * 1000;

  const todayMinutes = new Array(1440).fill(0);
  const yesterdayMinutes = new Array(1440).fill(0);
  const projects = new Set<string>();
  const sessions = new Set<string>();
  const entries24h: HistoryEntry[] = [];

  for (const entry of entries) {
    const ts = entry.timestamp;
    const d = new Date(ts);
    const minute = d.getHours() * 60 + d.getMinutes();

    if (ts >= todayStart) {
      todayMinutes[minute]++;
    } else if (ts >= yesterdayStart) {
      yesterdayMinutes[minute]++;
    }

    if (ts >= cutoff24h) {
      if (entry.project) projects.add(entry.project);
      if (entry.sessionId) sessions.add(entry.sessionId);
      entries24h.push(entry);
    }
  }

  return {
    todayMinutes,
    yesterdayMinutes,
    uniqueProjectCount: projects.size,
    uniqueSessionCount: sessions.size,
    peak: getPeakConcurrent(entries24h),
  };
}

function spark(data: number[], width: number): string {
  if (data.length === 0) return SPARK[0].repeat(width);
  const max = Math.max(...data, 1);
  const resampled: number[] = [];
  const step = data.length / width;
  for (let i = 0; i < width; i++) {
    resampled.push(data[Math.min(Math.floor(i * step), data.length - 1)]);
  }
  return resampled
    .map((v) => SPARK[Math.min(Math.floor((v / max) * 7), 7)])
    .join("");
}

// Build heatmap as a single ANSI string — replaces ~200 React elements
function buildHeatmap(todayMinutes: number[], yesterdayMinutes: number[], width: number): string {
  const labelWidth = 6;
  const barWidth = Math.max(width - labelWidth, 24);
  const minutesPerBucket = 1440 / barWidth;

  const todayBuckets = new Array(barWidth).fill(0);
  const yesterdayBuckets = new Array(barWidth).fill(0);
  for (let i = 0; i < 1440; i++) {
    const bucket = Math.min(Math.floor(i / minutesPerBucket), barWidth - 1);
    todayBuckets[bucket] += todayMinutes[i];
    yesterdayBuckets[bucket] += yesterdayMinutes[i];
  }

  const max = Math.max(...todayBuckets, ...yesterdayBuckets, 1);
  const now = new Date();
  const curBucket = Math.floor((now.getHours() * 60 + now.getMinutes()) / minutesPerBucket);

  const lines: string[] = [];
  lines.push(`${A.D}ACTIVITY (${Math.round(minutesPerBucket)}-min buckets)${A.R}`);

  let yest = `${A.D}${"YEST ".padEnd(labelWidth)}${A.R}`;
  for (let i = 0; i < barWidth; i++) {
    const level = Math.min(Math.floor((yesterdayBuckets[i] / max) * 4), 4);
    yest += `${yesterdayBuckets[i] === 0 ? A.gry : A.blu}${HEAT[level]}${A.R}`;
  }
  lines.push(yest);

  let today = `${A.D}${"TODAY ".padEnd(labelWidth)}${A.R}`;
  for (let i = 0; i < barWidth; i++) {
    const level = Math.min(Math.floor((todayBuckets[i] / max) * 4), 4);
    const c = i === curBucket ? `${A.B}${A.cyn}` : todayBuckets[i] === 0 ? A.gry : A.grn;
    today += `${c}${HEAT[level]}${A.R}`;
  }
  lines.push(today);

  const labels = new Array(barWidth).fill(" ");
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21]) {
    const pos = Math.floor((h * 60) / minutesPerBucket);
    if (pos + 1 < barWidth) {
      const lbl = String(h).padStart(2);
      labels[pos] = lbl[0];
      labels[pos + 1] = lbl[1];
    }
  }
  lines.push(`${A.D}${" ".repeat(labelWidth)}${labels.join("")}${A.R}`);

  return lines.join("\n");
}

// Build session table as a single ANSI string — replaces ~830 React elements
function buildSessionTable(sessions: ClaudeSession[], dirWidth: number): string {
  const lines: string[] = [];

  lines.push(
    `${A.D}${A.B}  ${"PID".padEnd(7)}${"TTY".padEnd(7)}${"UPTIME".padEnd(10)}` +
    `${"CPU".padEnd(7)}${"MEM".padEnd(7)}${"MODE".padEnd(9)}DIRECTORY${A.R}`
  );

  for (const s of sessions) {
    const dir = shortenPath(s.cwd, dirWidth);
    const mode = s.isSubagent ? "subagent" : s.flags.join(",") || "new";
    const uptime = formatDuration(s.elapsedSeconds);
    const cpu = s.cpuPercent.toFixed(1);

    const isWorking = s.turnState === "working" ||
      (s.turnState === "unknown" && s.cpuPercent > ACTIVE_CPU_THRESHOLD);

    const dotC = isWorking ? (s.cpuPercent > 10 ? A.grn : A.yel) : A.gry;
    const dot = isWorking ? (s.cpuPercent > 10 ? "\u26a1" : "\u25cf ") : "\u25cb ";
    const uptC = s.elapsedSeconds > 43200 ? A.red : s.elapsedSeconds > 3600 ? A.yel : A.wht;
    const cpuC = s.cpuPercent > 10 ? A.grn : s.cpuPercent > 1 ? A.yel : A.gry;
    const modC = s.isSubagent ? A.gry :
      s.flags.includes("resume") ? A.blu :
      s.flags.includes("continue") ? A.cyn : A.wht;

    lines.push(
      `${dotC}${dot}${A.R}${String(s.pid).padEnd(7)}` +
      `${A.gry}${s.tty.replace("ttys", "s").padEnd(7)}${A.R}` +
      `${uptC}${uptime.padEnd(10)}${A.R}` +
      `${cpuC}${(cpu + "%").padEnd(7)}${A.R}` +
      `${A.gry}${(s.rssMB + "M").padEnd(7)}${A.R}` +
      `${modC}${mode.padEnd(9)}${A.R}` +
      `${A.blu}${dir}${A.R}`
    );
  }

  if (sessions.length === 0) {
    lines.push(`${A.D}  No active Claude sessions detected${A.R}`);
  }

  return lines.join("\n");
}

// Build gauge bar as ANSI string
function buildGauge(value: number, max: number, width: number, label: string): string {
  const labelStr = `${label} `;
  const suffixStr = ` ${value}/${max}`;
  const barWidth = Math.max(width - labelStr.length - suffixStr.length, 10);
  const filled = Math.round((value / Math.max(max, 1)) * barWidth);
  const bar = "\u2588".repeat(Math.min(filled, barWidth)) + "\u2591".repeat(Math.max(barWidth - filled, 0));
  const c = value === 0 ? A.gry : value <= max * 0.3 ? A.grn : value <= max * 0.7 ? A.yel : A.red;
  return `${A.D}${labelStr}${A.R}${c}${bar}${A.R}${A.D}${suffixStr}${A.R}`;
}

// Pad a string to a fixed column width, using ANSI-aware logic
function col(text: string, width: number): string {
  // Strip ANSI for length measurement
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(width - visible.length, 0);
  return text + " ".repeat(pad);
}

// Build the entire live tab as a single ANSI string — ONE React element
function buildLiveView(p: {
  W: number; colW: number; sep: string; sparkWidth: number;
  activeSessions: ClaudeSession[]; idleSessions: ClaudeSession[];
  interactive: ClaudeSession[]; subagents: ClaudeSession[];
  totalCpu: number; totalMemGB: string; longestSession: number;
  historyDigest: HistoryDigest;
  lastSyncStr: string; lastSyncColor: string;
  countData: number[]; cpuData: number[]; peakSessions: number;
  sessions: ClaudeSession[]; dirWidth: number;
  tick: number; heapMB: number;
  projectGroups: Map<string, ClaudeSession[]>;
  usage: UsageInfo | null;
}): string {
  const lines: string[] = [];
  const { W, colW: cw, sep, sparkWidth } = p;
  const now = new Date();
  const timeStr = now.toLocaleTimeString();

  // Usage warning (only shown when >80% of any limit)
  let usageStr = "";
  if (p.usage) {
    const u = p.usage;
    const warnings: string[] = [];
    if (u.fiveHourPct >= 80) {
      const resetIn = Math.max(0, u.fiveHourResetMs - Date.now());
      const resetH = Math.floor(resetIn / 3600_000);
      const resetM = Math.floor((resetIn % 3600_000) / 60_000);
      const c = u.fiveHourPct >= 95 ? A.red : A.yel;
      warnings.push(`${c}${A.B}5h:${u.fiveHourPct}%${A.R}${A.D} ${resetH}h${resetM}m${A.R}`);
    }
    if (u.weeklyPct >= 80) {
      const resetIn = Math.max(0, u.weeklyResetMs - Date.now());
      const resetD = Math.floor(resetIn / 86400_000);
      const resetH = Math.floor((resetIn % 86400_000) / 3600_000);
      const c = u.weeklyPct >= 95 ? A.red : A.yel;
      warnings.push(`${c}${A.B}wk:${u.weeklyPct}%${A.R}${A.D} ${resetD}d${resetH}h${A.R}`);
    }
    if (warnings.length > 0) {
      usageStr = ` \u26a0 ${warnings.join(" ")} `;
    }
  }

  // Header
  const rightSide = `${usageStr}${A.D}${timeStr} | 3s refresh${A.R}`;
  const rightVisible = rightSide.replace(/\x1b\[[0-9;]*m/g, "");
  const headerPad = Math.max(W - 12 - rightVisible.length, 1);
  lines.push(`${A.B}${A.cyn}CLAUDE PULSE${A.R}${" ".repeat(headerPad)}${rightSide}`);

  // Tab bar
  const tabLive = `${A.B}${A.cyn} \u25b6 LIVE ${A.R}`;
  const tabHist = `${A.gry}   HISTORY ${A.R}`;
  lines.push(`${tabLive}${A.D} | ${A.R}${tabHist}${A.D}  (L=live H=history q=quit)${A.R}`);
  lines.push(`${A.D}${sep}${A.R}`);

  // Stats row 1
  const cpuC = p.totalCpu > 50 ? A.red : p.totalCpu > 10 ? A.yel : A.grn;
  const totalStr = p.subagents.length > 0
    ? `${A.B} ${p.interactive.length}${A.R}${A.D} +${p.subagents.length} sub${A.R}`
    : `${A.B} ${p.interactive.length}${A.R}`;
  lines.push(
    col(`${A.D}ACTIVE${A.R}\n${A.B}${A.grn} ${p.activeSessions.length}${A.R}`, cw) +
    col(`${A.D}IDLE${A.R}\n${A.B}${A.yel} ${p.idleSessions.length}${A.R}`, cw) +
    col(`${A.D}TOTAL${A.R}\n${totalStr}`, cw) +
    col(`${A.D}CPU${A.R}\n${A.B}${cpuC} ${p.totalCpu.toFixed(1)}%${A.R}`, cw) +
    `${A.D}MEMORY${A.R}\n${A.B} ${p.totalMemGB} GB${A.R}`
  );

  // Stats row 2
  const syncC = p.lastSyncColor === "green" ? A.grn : p.lastSyncColor === "red" ? A.red : p.lastSyncColor === "yellow" ? A.yel : A.gry;
  lines.push(
    col(`${A.D}LONGEST${A.R}\n${A.B}${A.yel} ${formatDuration(p.longestSession)}${A.R}`, cw) +
    col(`${A.D}24H SESSIONS${A.R}\n${A.B} ${p.historyDigest.uniqueSessionCount}${A.R}`, cw) +
    col(`${A.D}24H PROJECTS${A.R}\n${A.B} ${p.historyDigest.uniqueProjectCount}${A.R}`, cw) +
    col(`${A.D}24H PEAK${A.R}\n${A.B}${A.mag} ${p.historyDigest.peak.count} @ ${p.historyDigest.peak.label}${A.R}`, cw) +
    `${A.D}LAST SYNC${A.R}\n${A.B}${syncC} ${p.lastSyncStr}${A.R}`
  );

  // Sparklines
  lines.push(`${A.D}${sep}${A.R}`);
  lines.push(`${A.D}SESSIONS${A.R}`);
  lines.push(`${A.cyn}${spark(p.countData, sparkWidth)}${A.R}${A.D} peak ${p.peakSessions}${A.R}`);
  lines.push(`${A.D}CPU LOAD${A.R}`);
  lines.push(`${A.red}${spark(p.cpuData, sparkWidth)}${A.R}${A.D} peak ${Math.max(...p.cpuData, 0).toFixed(0)}%${A.R}`);
  lines.push(buildGauge(p.activeSessions.length, Math.max(p.sessions.length, 1), W, "Working"));

  // Heatmap
  lines.push(buildHeatmap(p.historyDigest.todayMinutes, p.historyDigest.yesterdayMinutes, W));

  // Session table
  lines.push(`${A.D}${sep}${A.R}`);
  lines.push(buildSessionTable(p.sessions, p.dirWidth));

  // Footer
  lines.push(`${A.D}${sep}${A.R}`);
  const footerLeft = `scan #${p.tick} | heap ${p.heapMB}MB`;
  const footerRight = `${p.interactive.length} sessions` +
    (p.subagents.length > 0 ? ` + ${p.subagents.length} subagents` : "") +
    ` | ${p.projectGroups.size} projects | ${p.totalMemGB} GB`;
  const footerPad = Math.max(W - footerLeft.length - footerRight.length, 1);
  lines.push(`${A.D}${footerLeft}${" ".repeat(footerPad)}${footerRight}${A.R}`);

  return lines.join("\n");
}

interface HistoryPoint {
  timestamp: number;
  count: number;
  activeCpu: number;
}

function HistoryView({
  W,
  trends,
  stats,
  loading,
}: {
  W: number;
  trends: TrendBucket[];
  stats: D1Stats | null;
  loading: boolean;
}) {
  const sep = "\u2500".repeat(W);
  const colW = Math.floor(W / 4);
  const sparkWidth = Math.max(W - 16, 20);

  if (loading) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Loading history from D1...</Text>
      </Box>
    );
  }

  const rs = getReportStatus();
  if (!rs.enabled) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">
          D1 not configured. Set CLAUDE_PULSE_API_KEY to enable history tracking.
        </Text>
      </Box>
    );
  }

  if (trends.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>No historical data yet. Snapshots are sent every 30s.</Text>
      </Box>
    );
  }

  const peakTotalData = trends.map((t) => t.peak_total);
  const peakActiveData = trends.map((t) => t.peak_active);
  const avgCpuData = trends.map((t) => t.avg_cpu);
  const peakCpuData = trends.map((t) => t.peak_cpu);
  const peakMemData = trends.map((t) => t.peak_mem_mb);

  // Build hour labels for trend sparklines
  const trendLabels: string[] = [];
  for (const t of trends) {
    const d = new Date(t.bucket * 1000);
    trendLabels.push(
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  }

  const firstLabel = trendLabels[0] ?? "";
  const lastLabel = trendLabels[trendLabels.length - 1] ?? "";

  return (
    <Box flexDirection="column">
      {/* Day/Week Summary */}
      {stats && (
        <>
          <Box marginTop={1}>
            <Text dimColor bold>
              SUMMARY
            </Text>
          </Box>
          <Box marginTop={1}>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>{"          "}</Text>
              <Text dimColor> 24H</Text>
              <Text dimColor> 7D</Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>PEAK SESSIONS</Text>
              <Text bold color="cyan">
                {" "}
                {stats.day.peak_sessions ?? 0}
              </Text>
              <Text bold color="cyan">
                {" "}
                {stats.week.peak_sessions ?? 0}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>PEAK ACTIVE</Text>
              <Text bold color="green">
                {" "}
                {stats.day.peak_active ?? 0}
              </Text>
              <Text bold color="green">
                {" "}
                {stats.week.peak_active ?? 0}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>PEAK CPU</Text>
              <Text bold color="red">
                {" "}
                {(stats.day.peak_cpu ?? 0).toFixed(1)}%
              </Text>
              <Text bold color="red">
                {" "}
                {(stats.week.peak_cpu ?? 0).toFixed(1)}%
              </Text>
            </Box>
          </Box>
          <Box>
            <Box flexDirection="column" width={colW}>
              <Text>{" "}</Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>AVG SESSIONS</Text>
              <Text bold>
                {" "}
                {stats.day.avg_sessions ?? 0}
              </Text>
              <Text bold>
                {" "}
                {stats.week.avg_sessions ?? 0}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>PEAK MEM</Text>
              <Text bold>
                {" "}
                {((stats.day.peak_mem_mb ?? 0) / 1024).toFixed(1)} GB
              </Text>
              <Text bold>
                {" "}
                {((stats.week.peak_mem_mb ?? 0) / 1024).toFixed(1)} GB
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>SAMPLES</Text>
              <Text bold dimColor>
                {" "}
                {stats.day.samples ?? 0}
              </Text>
              <Text bold dimColor>
                {" "}
                {stats.week.samples ?? 0}
              </Text>
            </Box>
          </Box>
        </>
      )}

      {/* Trend Sparklines */}
      <Box marginTop={1}>
        <Text dimColor>{sep}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor bold>
          24H TRENDS ({trends.length} hourly buckets: {firstLabel} \u2192{" "}
          {lastLabel})
        </Text>

        <Text dimColor>PEAK SESSIONS</Text>
        <Text color="cyan" wrap="truncate">
          {spark(peakTotalData, sparkWidth)}
          <Text dimColor>
            {" "}
            peak {Math.max(...peakTotalData)}
          </Text>
        </Text>

        <Text dimColor>PEAK ACTIVE</Text>
        <Text color="green" wrap="truncate">
          {spark(peakActiveData, sparkWidth)}
          <Text dimColor>
            {" "}
            peak {Math.max(...peakActiveData)}
          </Text>
        </Text>

        <Text dimColor>AVG CPU</Text>
        <Text color="yellow" wrap="truncate">
          {spark(avgCpuData, sparkWidth)}
          <Text dimColor>
            {" "}
            peak {Math.max(...avgCpuData).toFixed(0)}%
          </Text>
        </Text>

        <Text dimColor>PEAK CPU</Text>
        <Text color="red" wrap="truncate">
          {spark(peakCpuData, sparkWidth)}
          <Text dimColor>
            {" "}
            peak {Math.max(...peakCpuData).toFixed(0)}%
          </Text>
        </Text>

        <Text dimColor>PEAK MEMORY</Text>
        <Text color="magenta" wrap="truncate">
          {spark(peakMemData, sparkWidth)}
          <Text dimColor>
            {" "}
            peak {(Math.max(...peakMemData) / 1024).toFixed(1)} GB
          </Text>
        </Text>
      </Box>
    </Box>
  );
}

const EMPTY_DIGEST: HistoryDigest = {
  todayMinutes: new Array(1440).fill(0),
  yesterdayMinutes: new Array(1440).fill(0),
  uniqueProjectCount: 0,
  uniqueSessionCount: 0,
  peak: { count: 0, hour: 0, minute: 0, label: "0:00am" },
};

export default function App() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 120;
  const W = termWidth - 2;

  const [mode, setMode] = useState<TabMode>("live");
  const [sessions, setSessions] = useState<ClaudeSession[]>(getActiveSessions);
  const [timeline, setTimeline] = useState<HistoryPoint[]>([]);
  // Store only a compact digest — NOT thousands of raw HistoryEntry objects.
  // This prevents React's fiber tree from retaining huge object graphs.
  const [historyDigest, setHistoryDigest] = useState<HistoryDigest>(() => {
    try {
      return computeHistoryDigest(getRecentHistory(48));
    } catch {
      return EMPTY_DIGEST;
    }
  });
  const [tick, setTick] = useState(0);
  const [usage, setUsage] = useState<UsageInfo | null>(() => getUsageInfo());

  // History tab state
  const [trends, setTrends] = useState<TrendBucket[]>([]);
  const [stats, setStats] = useState<D1Stats | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Refs for comparing previous values to avoid unnecessary re-renders
  const prevSessionsRef = useRef<string>("");
  const prevHistoryKeyRef = useRef<string>("");
  const prevTrendsRef = useRef<string>("");
  const prevStatsRef = useRef<string>("");
  const tickRef = useRef(0);
  const historyLoadedRef = useRef(false);
  const historyLoadingRef = useRef(false);

  useInput(
    (input, key) => {
      if (input === "q") exit();
      if (input === "l" || input === "L") setMode("live");
      if (input === "h" || input === "H") setMode("history");
    },
    { isActive: isRawModeSupported }
  );

  // Fetch history data when switching to history tab
  useEffect(() => {
    if (mode !== "history") return;
    if (historyLoadedRef.current) return;

    if (!historyLoadingRef.current) {
      historyLoadingRef.current = true;
      setHistoryLoading(true);
    }
    Promise.all([fetchTrends(24), fetchStats()]).then(([t, s]) => {
      const trendsJson = JSON.stringify(t);
      if (trendsJson !== prevTrendsRef.current) {
        prevTrendsRef.current = trendsJson;
        setTrends(t);
      }
      const statsJson = JSON.stringify(s);
      if (statsJson !== prevStatsRef.current) {
        prevStatsRef.current = statsJson;
        setStats(s);
      }
      if (historyLoadingRef.current) {
        historyLoadingRef.current = false;
        setHistoryLoading(false);
      }
      historyLoadedRef.current = true;
      setHistoryLoaded(true);
    });
  }, [mode, historyLoaded]);

  // Refresh history data every 60s while on history tab
  useEffect(() => {
    if (mode !== "history") return;
    const interval = setInterval(() => {
      Promise.all([fetchTrends(24), fetchStats()]).then(([t, s]) => {
        const trendsJson = JSON.stringify(t);
        if (trendsJson !== prevTrendsRef.current) {
          prevTrendsRef.current = trendsJson;
          setTrends(t);
        }
        const statsJson = JSON.stringify(s);
        if (statsJson !== prevStatsRef.current) {
          prevStatsRef.current = statsJson;
          setStats(s);
        }
      });
    }, 60000);
    return () => clearInterval(interval);
  }, [mode]);

  // Invalidate history cache when switching away
  useEffect(() => {
    if (mode === "live") {
      if (historyLoadedRef.current) {
        historyLoadedRef.current = false;
        setHistoryLoaded(false);
      }
    }
  }, [mode]);

  useEffect(() => {
    const refresh = () => {
      // === Memory guard: runs every 3s BEFORE any allocation or render ===
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

      // Log heap every ~3 min for diagnosis
      if (tickRef.current > 0 && tickRef.current % 60 === 0) {
        process.stderr.write(
          `[pulse] tick=${tickRef.current} heap=${heapMB}MB\n`
        );
      }

      // Exit before OOM — supervisor restarts in 2s
      if (heapMB > HEAP_LIMIT_MB) {
        process.stderr.write(
          `[pulse] Heap ${heapMB}MB > ${HEAP_LIMIT_MB}MB limit. Exiting for restart.\n`
        );
        process.exit(1);
      }

      // Max lifetime: restart every 2h to reclaim any leaked memory
      if (Date.now() - PROCESS_START > MAX_LIFETIME_MS) {
        process.stderr.write(
          `[pulse] Max lifetime (2h) reached. Exiting for restart.\n`
        );
        process.exit(1);
      }

      const currentSessions = getActiveSessions();
      updateCompletedSessions(currentSessions);

      // Only update sessions state if data actually changed
      const sessionsKey = currentSessions
        .map(
          (s) =>
            `${s.pid}:${s.cpuPercent}:${s.rssMB}:${s.turnState}:${s.elapsedSeconds}`
        )
        .join("|");
      if (sessionsKey !== prevSessionsRef.current) {
        prevSessionsRef.current = sessionsKey;
        setSessions(currentSessions);
      }

      // Build the new timeline point
      const now = Date.now();
      const interactiveSessions = currentSessions.filter(
        (c) => !c.isSubagent
      );
      const workingCount = interactiveSessions.filter(
        (c) =>
          c.turnState === "working" ||
          (c.turnState === "unknown" && c.cpuPercent > ACTIVE_CPU_THRESHOLD)
      ).length;
      const activeCpu = currentSessions.reduce(
        (s, c) => s + c.cpuPercent,
        0
      );
      const point = {
        timestamp: now,
        count: workingCount,
        activeCpu,
      };

      setTimeline((prev) => {
        const cutoff = now - 60 * 60 * 1000;
        const filtered = [...prev, point].filter((p) => p.timestamp >= cutoff);
        let result: HistoryPoint[];
        if (filtered.length > 60) {
          const step = Math.ceil(filtered.length / 60);
          result = filtered.filter(
            (_, i) => i % step === 0 || i === filtered.length - 1
          );
        } else {
          result = filtered;
        }
        return result;
      });

      // Increment tick via ref; only trigger re-render for the tick display
      tickRef.current += 1;
      const currentTick = tickRef.current;

      // Every 10th tick, refresh history digest and report snapshot
      if (currentTick % 10 === 0) {
        const newHistory = getRecentHistory(48);
        // Lightweight fingerprint — no huge string construction
        const historyKey = `${newHistory.length}:${newHistory[newHistory.length - 1]?.timestamp ?? 0}`;
        if (historyKey !== prevHistoryKeyRef.current) {
          prevHistoryKeyRef.current = historyKey;
          // Compute digest immediately — newHistory becomes eligible for GC
          // as soon as computeHistoryDigest returns. No raw entries stored in React.
          setHistoryDigest(computeHistoryDigest(newHistory));
        }
        reportSnapshot(currentSessions);
        setUsage(getUsageInfo());
      }

      setTick(currentTick);
    };

    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  // Separate interactive sessions from subagents
  const interactive = sessions.filter((s) => !s.isSubagent);
  const subagents = sessions.filter((s) => s.isSubagent);

  // Primary: JSONL turn state (deterministic). Fallback: CPU for "unknown" state.
  const activeSessions = interactive.filter(
    (s) =>
      s.turnState === "working" ||
      (s.turnState === "unknown" && s.cpuPercent > ACTIVE_CPU_THRESHOLD)
  );
  const idleSessions = interactive.filter(
    (s) =>
      s.turnState === "idle" ||
      (s.turnState === "unknown" && s.cpuPercent <= ACTIVE_CPU_THRESHOLD)
  );
  const totalMemGB = (
    sessions.reduce((sum, s) => sum + s.rssMB, 0) / 1024
  ).toFixed(1);
  const totalCpu = sessions.reduce((sum, s) => sum + s.cpuPercent, 0);
  const longestSession = interactive.reduce(
    (max, s) => (s.elapsedSeconds > max ? s.elapsedSeconds : max),
    0
  );

  const countData = timeline.map((h) => h.count);
  const cpuData = timeline.map((h) => h.activeCpu);
  const peakSessions = Math.max(...countData, sessions.length);

  const now = new Date();
  const timeStr = now.toLocaleTimeString();

  const projectGroups = new Map<string, ClaudeSession[]>();
  for (const s of sessions) {
    const key = shortenPath(s.cwd, 35);
    const group = projectGroups.get(key) ?? [];
    group.push(s);
    projectGroups.set(key, group);
  }

  const colW = Math.floor(W / 5);
  const fixedCols = 49;
  const dirWidth = Math.max(W - fixedCols, 20);
  const sparkWidth = Math.max(W - 12, 20);
  const sep = "\u2500".repeat(W);

  // Last sync display
  const rs = getReportStatus();
  let lastSyncStr = "n/a";
  let lastSyncColor: string = "gray";
  if (!rs.enabled) {
    lastSyncStr = "off";
    lastSyncColor = "gray";
  } else if (rs.lastError) {
    lastSyncStr = "error";
    lastSyncColor = "red";
  } else if (rs.lastSent) {
    const ago = Math.round((Date.now() - rs.lastSent) / 1000);
    lastSyncStr = `${ago}s ago`;
    lastSyncColor = ago < 60 ? "green" : "yellow";
  } else {
    lastSyncStr = "pending";
    lastSyncColor = "gray";
  }

  const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  // Build the entire live view as a single ANSI string.
  // Ink leaks ~140 bytes per React element per render. By rendering
  // the whole view as one <Text>, the leak rate drops to near zero.
  const liveView = buildLiveView({
    W, colW, sep, sparkWidth,
    activeSessions, idleSessions, interactive, subagents,
    totalCpu, totalMemGB, longestSession,
    historyDigest, lastSyncStr, lastSyncColor,
    countData, cpuData, peakSessions,
    sessions, dirWidth, tick, heapMB, projectGroups, usage,
  });

  // Minimal React tree: Box > Text (header) + Text (content) + Text (for history tab)
  // Total elements: ~5 for live tab, ~70 for history tab (only when active)
  return (
    <Box flexDirection="column" paddingX={1}>
      {mode === "live" ? (
        <Text>{liveView}</Text>
      ) : (
        <HistoryView
          W={W}
          trends={trends}
          stats={stats}
          loading={historyLoading}
        />
      )}
    </Box>
  );
}

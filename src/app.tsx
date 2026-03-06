import React, { useState, useEffect } from "react";
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

const SPARK = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
const HEAT = ["\u00b7", "\u2591", "\u2592", "\u2593", "\u2588"];

type TabMode = "live" | "history";

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

function Gauge({
  value,
  max,
  width,
  label,
}: {
  value: number;
  max: number;
  width: number;
  label: string;
}) {
  const labelStr = `${label} `;
  const suffixStr = ` ${value}/${max}`;
  const barWidth = Math.max(width - labelStr.length - suffixStr.length, 10);
  const filled = Math.round((value / Math.max(max, 1)) * barWidth);
  const bar =
    "\u2588".repeat(Math.min(filled, barWidth)) +
    "\u2591".repeat(Math.max(barWidth - filled, 0));
  const color =
    value === 0
      ? "gray"
      : value <= max * 0.3
        ? "green"
        : value <= max * 0.7
          ? "yellow"
          : "red";
  return (
    <Text>
      <Text dimColor>{labelStr}</Text>
      <Text color={color}>{bar}</Text>
      <Text dimColor>{suffixStr}</Text>
    </Text>
  );
}

function HourlyHeatmap({
  history,
  width,
}: {
  history: HistoryEntry[];
  width: number;
}) {
  const bucketCount = Math.max(width, 24);
  const minutesPerBucket = (24 * 60) / bucketCount;
  const buckets = new Array(bucketCount).fill(0);
  const now = new Date();
  const currentBucket = Math.floor(
    (now.getHours() * 60 + now.getMinutes()) / minutesPerBucket
  );

  for (const entry of history) {
    const d = new Date(entry.timestamp);
    const bucket = Math.floor(
      (d.getHours() * 60 + d.getMinutes()) / minutesPerBucket
    );
    if (bucket < bucketCount) buckets[bucket]++;
  }
  const max = Math.max(...buckets, 1);

  const labels = new Array(bucketCount).fill(" ");
  const hoursToLabel = [0, 3, 6, 9, 12, 15, 18, 21];
  for (const h of hoursToLabel) {
    const pos = Math.floor((h * 60) / minutesPerBucket);
    if (pos + 1 < bucketCount) {
      const lbl = String(h).padStart(2);
      labels[pos] = lbl[0];
      labels[pos + 1] = lbl[1];
    }
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>
        24H ACTIVITY ({Math.round(minutesPerBucket)}-min buckets)
      </Text>
      <Box>
        {buckets.map((count, i) => {
          const level = Math.min(Math.floor((count / max) * 4), 4);
          const isCurrent = i === currentBucket;
          return (
            <Text
              key={`heat-${i}`}
              color={isCurrent ? "cyan" : count === 0 ? "gray" : "yellow"}
              bold={isCurrent}
            >
              {HEAT[level]}
            </Text>
          );
        })}
      </Box>
      <Box>
        <Text dimColor>{labels.join("")}</Text>
      </Box>
    </Box>
  );
}

interface HistoryPoint {
  timestamp: number;
  count: number;
  activeCpu: number;
}

function TabBar({ mode, W }: { mode: TabMode; W: number }) {
  const sep = "\u2500".repeat(W);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold={mode === "live"} color={mode === "live" ? "cyan" : "gray"}>
          {mode === "live" ? " \u25b6 LIVE " : "   LIVE "}
        </Text>
        <Text dimColor> | </Text>
        <Text
          bold={mode === "history"}
          color={mode === "history" ? "magenta" : "gray"}
        >
          {mode === "history" ? " \u25b6 HISTORY " : "   HISTORY "}
        </Text>
        <Text dimColor>
          {"  "}(L=live H=history q=quit)
        </Text>
      </Box>
      <Text dimColor>{sep}</Text>
    </Box>
  );
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

export default function App() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 120;
  const W = termWidth - 2;

  const [mode, setMode] = useState<TabMode>("live");
  const [sessions, setSessions] = useState<ClaudeSession[]>(getActiveSessions);
  const [timeline, setTimeline] = useState<HistoryPoint[]>([]);
  const [recentHistory, setRecentHistory] = useState<HistoryEntry[]>(() =>
    getRecentHistory(24)
  );
  const [tick, setTick] = useState(0);

  // History tab state
  const [trends, setTrends] = useState<TrendBucket[]>([]);
  const [stats, setStats] = useState<D1Stats | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);

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
    if (historyLoaded) return;

    setHistoryLoading(true);
    Promise.all([fetchTrends(24), fetchStats()]).then(([t, s]) => {
      setTrends(t);
      setStats(s);
      setHistoryLoading(false);
      setHistoryLoaded(true);
    });
  }, [mode, historyLoaded]);

  // Refresh history data every 60s while on history tab
  useEffect(() => {
    if (mode !== "history") return;
    const interval = setInterval(() => {
      Promise.all([fetchTrends(24), fetchStats()]).then(([t, s]) => {
        setTrends(t);
        setStats(s);
      });
    }, 60000);
    return () => clearInterval(interval);
  }, [mode]);

  // Invalidate history cache when switching away
  useEffect(() => {
    if (mode === "live") setHistoryLoaded(false);
  }, [mode]);

  useEffect(() => {
    const refresh = () => {
      const currentSessions = getActiveSessions();
      setSessions(currentSessions);
      updateCompletedSessions(currentSessions);

      setTimeline((prev) => {
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
        const cutoff = now - 60 * 60 * 1000;
        const filtered = [...prev, point].filter((p) => p.timestamp >= cutoff);
        if (filtered.length > 60) {
          const step = Math.ceil(filtered.length / 60);
          return filtered.filter(
            (_, i) => i % step === 0 || i === filtered.length - 1
          );
        }
        return filtered;
      });

      setTick((t) => {
        if (t % 10 === 0) {
          setRecentHistory(getRecentHistory(24));
          reportSnapshot(currentSessions);
        }
        return t + 1;
      });
    };

    refresh();
    setRecentHistory(getRecentHistory(24));
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

  const uniqueProjects = new Set(
    recentHistory.map((h) => h.project).filter(Boolean)
  );
  const uniqueSessions24h = new Set(
    recentHistory.map((h) => h.sessionId).filter(Boolean)
  );
  const peak24h = getPeakConcurrent(recentHistory);

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

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          CLAUDE PULSE
        </Text>
        <Text dimColor>{timeStr} | 3s refresh</Text>
      </Box>

      {/* Tab Bar */}
      <Box marginTop={1}>
        <TabBar mode={mode} W={W} />
      </Box>

      {mode === "live" ? (
        <>
          {/* Stats Grid - 5 columns, aligned across both rows */}
          <Box marginTop={1}>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>ACTIVE</Text>
              <Text bold color="green">
                {" "}
                {activeSessions.length}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>IDLE</Text>
              <Text bold color="yellow">
                {" "}
                {idleSessions.length}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>TOTAL</Text>
              <Text bold>
                {" "}
                {interactive.length}
                {subagents.length > 0 && (
                  <Text dimColor> +{subagents.length} sub</Text>
                )}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>CPU</Text>
              <Text
                bold
                color={
                  totalCpu > 50 ? "red" : totalCpu > 10 ? "yellow" : "green"
                }
              >
                {" "}
                {totalCpu.toFixed(1)}%
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>MEMORY</Text>
              <Text bold>
                {" "}
                {totalMemGB} GB
              </Text>
            </Box>
          </Box>
          <Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>LONGEST</Text>
              <Text bold color="yellow">
                {" "}
                {formatDuration(longestSession)}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>24H SESSIONS</Text>
              <Text bold>
                {" "}
                {uniqueSessions24h.size}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>24H PROJECTS</Text>
              <Text bold>
                {" "}
                {uniqueProjects.size}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>24H PEAK</Text>
              <Text bold color="magenta">
                {" "}
                {peak24h.count} @ {peak24h.label}
              </Text>
            </Box>
            <Box flexDirection="column" width={colW}>
              <Text dimColor>LAST SYNC</Text>
              <Text bold color={lastSyncColor as any}>
                {" "}
                {lastSyncStr}
              </Text>
            </Box>
          </Box>

          {/* Charts */}
          <Box marginTop={1}>
            <Text dimColor>{sep}</Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>SESSIONS</Text>
            <Text color="cyan" wrap="truncate">
              {spark(countData, sparkWidth)}
              <Text dimColor> peak {peakSessions}</Text>
            </Text>

            <Text dimColor>CPU LOAD</Text>
            <Text color="red" wrap="truncate">
              {spark(cpuData, sparkWidth)}
              <Text dimColor>
                {" "}
                peak {Math.max(...cpuData, 0).toFixed(0)}%
              </Text>
            </Text>

            <Gauge
              value={activeSessions.length}
              max={Math.max(sessions.length, 1)}
              width={W}
              label="Working"
            />
          </Box>

          {/* Heatmap */}
          <Box marginTop={1}>
            <HourlyHeatmap history={recentHistory} width={W} />
          </Box>

          {/* Session List */}
          <Box marginTop={1}>
            <Text dimColor>{sep}</Text>
          </Box>

          <Box flexDirection="column">
            <Text dimColor bold wrap="truncate">
              {"  "}
              {"PID".padEnd(7)}
              {"TTY".padEnd(7)}
              {"UPTIME".padEnd(10)}
              {"CPU".padEnd(7)}
              {"MEM".padEnd(7)}
              {"MODE".padEnd(9)}
              {"DIRECTORY"}
            </Text>

            {sessions.map((s) => {
              const dir = shortenPath(s.cwd, dirWidth);
              const sessionMode = s.isSubagent
                ? "subagent"
                : s.flags.join(",") || "new";
              const uptime = formatDuration(s.elapsedSeconds);
              const cpu = s.cpuPercent.toFixed(1);
              const uptimeColor =
                s.elapsedSeconds > 43200
                  ? "red"
                  : s.elapsedSeconds > 3600
                    ? "yellow"
                    : ("white" as const);
              const cpuColor =
                s.cpuPercent > 10
                  ? "green"
                  : s.cpuPercent > 1
                    ? "yellow"
                    : ("gray" as const);
              const modeColor = s.isSubagent
                ? "gray"
                : s.flags.includes("resume")
                  ? "blue"
                  : s.flags.includes("continue")
                    ? "cyan"
                    : ("white" as const);
              const isWorking =
                s.turnState === "working" ||
                (s.turnState === "unknown" &&
                  s.cpuPercent > ACTIVE_CPU_THRESHOLD);
              const dot = isWorking
                ? s.cpuPercent > 10
                  ? "\u26a1"
                  : "\u25cf "
                : "\u25cb ";
              const dotColor = isWorking
                ? s.cpuPercent > 10
                  ? "green"
                  : "yellow"
                : ("gray" as const);

              return (
                <Text key={`s-${s.pid}`} wrap="truncate">
                  <Text color={dotColor}>{dot}</Text>
                  <Text>{String(s.pid).padEnd(7)}</Text>
                  <Text dimColor>
                    {s.tty.replace("ttys", "s").padEnd(7)}
                  </Text>
                  <Text color={uptimeColor}>{uptime.padEnd(10)}</Text>
                  <Text color={cpuColor}>{(cpu + "%").padEnd(7)}</Text>
                  <Text dimColor>{(s.rssMB + "M").padEnd(7)}</Text>
                  <Text color={modeColor}>{sessionMode.padEnd(9)}</Text>
                  <Text color="blue">{dir}</Text>
                </Text>
              );
            })}

            {sessions.length === 0 && (
              <Box marginTop={1} justifyContent="center">
                <Text dimColor>No active Claude sessions detected</Text>
              </Box>
            )}
          </Box>
        </>
      ) : (
        <HistoryView
          W={W}
          trends={trends}
          stats={stats}
          loading={historyLoading}
        />
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{sep}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>scan #{tick}</Text>
        <Text dimColor>
          {interactive.length} sessions
          {subagents.length > 0 && ` + ${subagents.length} subagents`} |{" "}
          {projectGroups.size} projects | {totalMemGB} GB
        </Text>
      </Box>
    </Box>
  );
}

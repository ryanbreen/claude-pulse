import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import {
  getActiveSessions,
  getRecentHistory,
  formatDuration,
  shortenPath,
  type ClaudeSession,
  type HistoryEntry,
} from "./scanner.js";

const SPARK = "▁▂▃▄▅▆▇█";
const HEAT = ["·", "░", "▒", "▓", "█"];

function spark(data: number[]): string {
  if (data.length === 0) return "";
  const max = Math.max(...data, 1);
  return data
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
  const filled = Math.round((value / Math.max(max, 1)) * width);
  const bar =
    "█".repeat(Math.min(filled, width)) +
    "░".repeat(Math.max(width - filled, 0));
  const color =
    value === 0
      ? "gray"
      : value <= max * 0.3
        ? "green"
        : value <= max * 0.7
          ? "yellow"
          : "red";
  return (
    <Box>
      <Text dimColor>{label} </Text>
      <Text color={color}>{bar}</Text>
      <Text dimColor>
        {" "}
        {value}/{max}
      </Text>
    </Box>
  );
}

function HourlyHeatmap({ history }: { history: HistoryEntry[] }) {
  // 72 buckets = 20-minute intervals across 24 hours
  const BUCKETS = 72;
  const buckets = new Array(BUCKETS).fill(0);
  const now = new Date();
  const currentBucket = now.getHours() * 3 + Math.floor(now.getMinutes() / 20);

  for (const entry of history) {
    const d = new Date(entry.timestamp);
    const bucket = d.getHours() * 3 + Math.floor(d.getMinutes() / 20);
    buckets[bucket]++;
  }
  const max = Math.max(...buckets, 1);

  // Build hour labels aligned to the 72-char width (every 3 chars = 1 hour)
  const labels = new Array(BUCKETS).fill(" ");
  for (let h = 0; h < 24; h += 3) {
    const pos = h * 3;
    const lbl = String(h).padStart(2);
    labels[pos] = lbl[0];
    labels[pos + 1] = lbl[1];
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>24H ACTIVITY (20-min buckets)</Text>
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

function KeyHandler() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  useInput(
    (input) => {
      if (input === "q") exit();
    },
    { isActive: isRawModeSupported }
  );
  return null;
}

export default function App() {
  const [sessions, setSessions] = useState<ClaudeSession[]>(getActiveSessions);
  const [timeline, setTimeline] = useState<HistoryPoint[]>([]);
  const [recentHistory, setRecentHistory] = useState<HistoryEntry[]>(() =>
    getRecentHistory(24)
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => {
      const currentSessions = getActiveSessions();
      setSessions(currentSessions);

      setTimeline((prev) => {
        const now = Date.now();
        const activeCpu = currentSessions.reduce(
          (s, c) => s + c.cpuPercent,
          0
        );
        const point = {
          timestamp: now,
          count: currentSessions.length,
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

      // Refresh history less frequently (every 10 ticks = 30s)
      setTick((t) => {
        if (t % 10 === 0) {
          setRecentHistory(getRecentHistory(24));
        }
        return t + 1;
      });
    };

    refresh();
    setRecentHistory(getRecentHistory(24));
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, []);

  const activeSessions = sessions.filter((s) => s.cpuPercent > 0.5);
  const idleSessions = sessions.filter((s) => s.cpuPercent <= 0.5);
  const totalMemGB = (
    sessions.reduce((sum, s) => sum + s.rssMB, 0) / 1024
  ).toFixed(1);
  const totalCpu = sessions.reduce((sum, s) => sum + s.cpuPercent, 0);
  const longestSession = sessions.reduce(
    (max, s) => (s.elapsedSeconds > max ? s.elapsedSeconds : max),
    0
  );

  const uniqueProjects = new Set(
    recentHistory.map((h) => h.project).filter(Boolean)
  );
  const uniqueSessions24h = new Set(
    recentHistory.map((h) => h.sessionId).filter(Boolean)
  );

  const countData = timeline.map((h) => h.count);
  const cpuData = timeline.map((h) => h.activeCpu);
  const peakSessions = Math.max(...countData, sessions.length);

  const now = new Date();
  const timeStr = now.toLocaleTimeString();

  // Group sessions by project directory (first 2 meaningful path segments)
  const projectGroups = new Map<string, ClaudeSession[]>();
  for (const s of sessions) {
    const key = shortenPath(s.cwd, 35);
    const group = projectGroups.get(key) ?? [];
    group.push(s);
    projectGroups.set(key, group);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <KeyHandler />
      {/* Header */}
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="magenta">
            {"  "}
          </Text>
          <Text bold color="cyan">
            CLAUDE PULSE
          </Text>
        </Box>
        <Text dimColor>
          {timeStr} | 3s refresh | q quit
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(72)}</Text>
      </Box>

      {/* Stats Row 1 */}
      <Box marginTop={1} gap={2}>
        <Box flexDirection="column" width={16}>
          <Text dimColor>ACTIVE</Text>
          <Text bold color="green">
            {" "}
            {activeSessions.length}
          </Text>
        </Box>
        <Box flexDirection="column" width={16}>
          <Text dimColor>IDLE</Text>
          <Text bold color="yellow">
            {" "}
            {idleSessions.length}
          </Text>
        </Box>
        <Box flexDirection="column" width={16}>
          <Text dimColor>TOTAL</Text>
          <Text bold>
            {" "}
            {sessions.length}
          </Text>
        </Box>
        <Box flexDirection="column" width={16}>
          <Text dimColor>CPU</Text>
          <Text
            bold
            color={totalCpu > 50 ? "red" : totalCpu > 10 ? "yellow" : "green"}
          >
            {" "}
            {totalCpu.toFixed(1)}%
          </Text>
        </Box>
      </Box>

      {/* Stats Row 2 */}
      <Box gap={2}>
        <Box flexDirection="column" width={16}>
          <Text dimColor>MEMORY</Text>
          <Text bold>
            {" "}
            {totalMemGB} GB
          </Text>
        </Box>
        <Box flexDirection="column" width={16}>
          <Text dimColor>LONGEST</Text>
          <Text bold color="yellow">
            {" "}
            {formatDuration(longestSession)}
          </Text>
        </Box>
        <Box flexDirection="column" width={16}>
          <Text dimColor>24H SESSIONS</Text>
          <Text bold>
            {" "}
            {uniqueSessions24h.size}
          </Text>
        </Box>
        <Box flexDirection="column" width={16}>
          <Text dimColor>24H PROJECTS</Text>
          <Text bold>
            {" "}
            {uniqueProjects.size}
          </Text>
        </Box>
      </Box>

      {/* Charts */}
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(72)}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box gap={4}>
          <Box flexDirection="column">
            <Text dimColor>SESSIONS </Text>
            <Text color="cyan">
              {spark(countData)}
              <Text dimColor> peak {peakSessions}</Text>
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>CPU LOAD </Text>
            <Text color="red">
              {spark(cpuData)}
              <Text dimColor>
                {" "}
                peak {Math.max(...cpuData, 0).toFixed(0)}%
              </Text>
            </Text>
          </Box>
        </Box>

        <Box marginTop={1}>
          <Gauge
            value={activeSessions.length}
            max={Math.max(sessions.length, 1)}
            width={35}
            label="Working"
          />
        </Box>
      </Box>

      {/* Heatmap */}
      <Box marginTop={1}>
        <HourlyHeatmap history={recentHistory} />
      </Box>

      {/* Session List */}
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(72)}</Text>
      </Box>

      <Box flexDirection="column">
        {/* Table header */}
        <Text dimColor bold>
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
          const dir = shortenPath(s.cwd, 30);
          const mode = s.flags.join(",") || "new";
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
          const modeColor = s.flags.includes("resume")
            ? "blue"
            : s.flags.includes("continue")
              ? "cyan"
              : ("white" as const);
          const dot =
            s.cpuPercent > 10 ? "⚡" : s.cpuPercent > 0.5 ? "● " : "○ ";
          const dotColor =
            s.cpuPercent > 10
              ? "green"
              : s.cpuPercent > 0.5
                ? "yellow"
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
              <Text color={modeColor}>{mode.padEnd(9)}</Text>
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

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>{"─".repeat(72)}</Text>
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          scan #{tick}
        </Text>
        <Text dimColor>
          {sessions.length} sessions | {projectGroups.size} projects |{" "}
          {totalMemGB} GB
        </Text>
      </Box>
    </Box>
  );
}

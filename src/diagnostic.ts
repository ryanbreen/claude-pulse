/**
 * Headless diagnostic: runs the same refresh cycle as app.tsx but WITHOUT
 * Ink/React. If memory grows here, the leak is in scanner/state/reporter.
 * If it doesn't, the leak is in Ink/React rendering.
 *
 * Usage: NODE_OPTIONS='--expose-gc --max-old-space-size=512' npx tsx src/diagnostic.ts
 */
import v8 from "v8";
import { getActiveSessions, getRecentHistory, getPeakConcurrent } from "./scanner.js";
import { updateCompletedSessions } from "./state.js";
import { reportSnapshot } from "./reporter.js";

let tick = 0;
let prevSessionsKey = "";
let prevHistoryKey = "";

// Simulates exactly what app.tsx does each cycle, minus React
function refresh() {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const heap = process.memoryUsage();
  const heapMB = Math.round(heap.heapUsed / 1024 / 1024);
  const rssMB = Math.round(heap.rss / 1024 / 1024);

  if (tick % 10 === 0) {
    const stats = v8.getHeapStatistics();
    console.log(
      `tick=${tick} heap=${heapMB}MB rss=${rssMB}MB ` +
      `heapTotal=${Math.round(stats.total_heap_size / 1024 / 1024)}MB ` +
      `external=${Math.round(stats.external_memory / 1024 / 1024)}MB ` +
      `contexts=${stats.number_of_native_contexts}`
    );
  }

  // === Exactly what refresh() in app.tsx does ===

  const currentSessions = getActiveSessions();
  updateCompletedSessions(currentSessions);

  // Session key comparison (stored in ref in real app)
  const sessionsKey = currentSessions
    .map(s => `${s.pid}:${s.cpuPercent}:${s.rssMB}:${s.turnState}:${s.elapsedSeconds}`)
    .join("|");
  prevSessionsKey = sessionsKey;

  // Timeline point (simulated — no React state)
  const interactiveSessions = currentSessions.filter(c => !c.isSubagent);
  const workingCount = interactiveSessions.filter(
    c => c.turnState === "working" || (c.turnState === "unknown" && c.cpuPercent > 3.0)
  ).length;
  const activeCpu = currentSessions.reduce((s, c) => s + c.cpuPercent, 0);

  // Every 10th tick: history + report (same as real app)
  if (tick % 10 === 0) {
    const newHistory = getRecentHistory(48);
    const historyKey = `${newHistory.length}:${newHistory[newHistory.length - 1]?.timestamp ?? 0}`;
    if (historyKey !== prevHistoryKey) {
      prevHistoryKey = historyKey;
      // Simulate computeHistoryDigest
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const yesterdayStart = todayStart - 86400000;
      const cutoff24h = Date.now() - 24 * 3600 * 1000;
      const todayMinutes = new Array(1440).fill(0);
      const yesterdayMinutes = new Array(1440).fill(0);
      const projects = new Set<string>();
      const sessions = new Set<string>();
      const entries24h: typeof newHistory = [];
      for (const entry of newHistory) {
        const ts = entry.timestamp;
        const d = new Date(ts);
        const minute = d.getHours() * 60 + d.getMinutes();
        if (ts >= todayStart) todayMinutes[minute]++;
        else if (ts >= yesterdayStart) yesterdayMinutes[minute]++;
        if (ts >= cutoff24h) {
          if (entry.project) projects.add(entry.project);
          if (entry.sessionId) sessions.add(entry.sessionId);
          entries24h.push(entry);
        }
      }
      getPeakConcurrent(entries24h);
    }
    reportSnapshot(currentSessions);
  }

  tick++;
}

console.log("=== Claude Pulse Diagnostic (headless, no Ink/React) ===");
console.log(`Sessions detected: ${getActiveSessions().length}`);
console.log("Running refresh every 3s. Watch heap column for growth.\n");

// Take heap snapshot at tick 50 (~2.5 min) and tick 150 (~7.5 min)
const SNAPSHOT_TICKS = [50, 150];

setInterval(() => {
  refresh();
  if (SNAPSHOT_TICKS.includes(tick)) {
    const file = v8.writeHeapSnapshot();
    console.log(`\n>>> HEAP SNAPSHOT written: ${file}\n`);
  }
  if (tick >= 200) {
    console.log("\n=== Done (200 ticks). Compare the two .heapsnapshot files in Chrome DevTools ===");
    process.exit(0);
  }
}, 3000);

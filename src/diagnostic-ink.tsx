/**
 * Minimal Ink reproduction to isolate what causes the memory leak.
 * Tests different rendering patterns to find which one leaks.
 *
 * Usage: NODE_OPTIONS='--expose-gc --max-old-space-size=512' npx tsx src/diagnostic-ink.tsx
 */
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout } from "ink";

// Test mode — change this to test different patterns:
// "static"    = render same static content every tick (baseline)
// "counter"   = re-render with changing counter only
// "setState"  = multiple setState calls per tick
// "bigstring" = single <Text> with large changing string
// "manyelems" = 100 individual <Text> elements (simulates session list)
const TEST_MODE = process.argv[2] || "manyelems";

function App() {
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<string[]>([]);
  const tickRef = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof globalThis.gc === "function") globalThis.gc();
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

      tickRef.current++;
      const t = tickRef.current;

      if (t % 20 === 0) {
        process.stderr.write(`[${TEST_MODE}] tick=${t} heap=${heapMB}MB\n`);
      }

      if (t > 400) {
        process.stderr.write(`[${TEST_MODE}] Done at tick=${t} heap=${heapMB}MB\n`);
        process.exit(0);
      }

      // Simulate data refresh
      const newData: string[] = [];
      for (let i = 0; i < 90; i++) {
        newData.push(`Session ${i} pid=${10000 + i} cpu=${(Math.random() * 10).toFixed(1)}% mem=${Math.floor(Math.random() * 500)}MB`);
      }

      if (TEST_MODE === "counter") {
        setTick(t);
      } else if (TEST_MODE === "setState") {
        setData(newData);
        setTick(t);
      } else if (TEST_MODE === "bigstring" || TEST_MODE === "manyelems") {
        setData(newData);
        setTick(t);
      } else {
        // static — only update tick
        setTick(t);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  if (TEST_MODE === "static") {
    return <Text>Static content, tick {tick}</Text>;
  }

  if (TEST_MODE === "counter") {
    return <Text>Counter: {tick}</Text>;
  }

  if (TEST_MODE === "bigstring") {
    // Single <Text> with a large string — like our ANSI approach
    const bigStr = data.join("\n");
    return <Text>{bigStr}</Text>;
  }

  if (TEST_MODE === "manyelems") {
    // Many individual <Text> elements — like old session list
    return (
      <Box flexDirection="column">
        <Text>Tick {tick} — {data.length} sessions</Text>
        {data.map((line, i) => (
          <Text key={i}>
            <Text color="green">● </Text>
            <Text>{line}</Text>
          </Text>
        ))}
      </Box>
    );
  }

  return <Text>Unknown mode: {TEST_MODE}</Text>;
}

process.stderr.write(`=== Ink Diagnostic: mode=${TEST_MODE} ===\n`);
render(<App />);

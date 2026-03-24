import React from "react";
import { render } from "ink";
import { spawn, execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const args = process.argv.slice(2);

if (args.includes("--snapshot") || args.includes("-s")) {
  // Non-interactive one-shot mode
  import("./snapshot.js").then(({ renderSnapshot }) => {
    console.log(renderSnapshot());
  });
} else {
  // Interactive TUI mode
  const { default: App } = await import("./app.js");

  // Backup heap watchdog (primary one is in the 3s refresh callback in app.tsx).
  const gcAvailable = typeof globalThis.gc === "function";
  process.stderr.write(
    `[pulse] Started. gc=${gcAvailable ? "yes" : "NO"} pid=${process.pid} tty=${process.stdin.isTTY ?? false}\n`
  );
  setInterval(() => {
    if (gcAvailable) (globalThis as any).gc();
    const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heapMB > 350) {
      process.stderr.write(
        `[pulse] Backup watchdog: ${Math.round(heapMB)}MB > 350MB. Exiting.\n`
      );
      process.exit(1);
    }
  }, 10_000);

  // Clear screen and move cursor to top before rendering
  process.stdout.write("\x1b[2J\x1b[H");

  // Launch floating badge if binary exists and --no-badge not passed
  if (!args.includes("--no-badge")) {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const badgePath = join(thisDir, "..", "bin", "claude-badge");
    if (existsSync(badgePath)) {
      const badgeProc = spawn(badgePath, [], {
        detached: true,
        stdio: "ignore",
      });
      badgeProc.unref();

      process.on("exit", () => {
        try {
          if (badgeProc.pid) process.kill(badgeProc.pid);
        } catch {}
      });
    }
  }

  render(<App />, {
    exitOnCtrlC: true,
  });
}

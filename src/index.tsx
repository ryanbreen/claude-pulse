import React from "react";
import { render } from "ink";
import { spawn } from "child_process";
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
  // This one runs on a separate 10s timer as a safety net.
  const gcAvailable = typeof globalThis.gc === "function";
  process.stderr.write(
    `[pulse] Started. gc=${gcAvailable ? "yes" : "NO (--expose-gc missing?)"} pid=${process.pid} stdin.isTTY=${process.stdin.isTTY}\n`
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

  const hasStdin =
    process.stdin.isTTY === true &&
    typeof process.stdin.setRawMode === "function";

  // Clear screen and move cursor to top before rendering
  process.stdout.write("\x1b[2J\x1b[H");

  // Launch floating badge if binary exists and --no-badge not passed
  let badgeProc: ReturnType<typeof spawn> | null = null;
  if (!args.includes("--no-badge")) {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const badgePath = join(thisDir, "..", "bin", "claude-badge");
    if (existsSync(badgePath)) {
      badgeProc = spawn(badgePath, [], {
        detached: true,
        stdio: "ignore",
      });
      badgeProc.unref();

      // Kill badge when TUI exits. Only use "exit" event — registering
      // SIGINT/SIGTERM handlers overrides Node's default behavior (exit),
      // which was preventing Ctrl+C from actually killing the process.
      process.on("exit", () => {
        if (badgeProc?.pid) {
          try {
            process.kill(badgeProc.pid);
          } catch {}
        }
      });
    }
  }

  render(<App />, {
    exitOnCtrlC: true,
    ...(hasStdin ? {} : { stdin: undefined }),
  });
}

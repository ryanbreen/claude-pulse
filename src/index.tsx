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

      // Kill badge when TUI exits
      const cleanup = () => {
        if (badgeProc?.pid) {
          try {
            process.kill(badgeProc.pid);
          } catch {}
        }
      };
      process.on("exit", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    }
  }

  render(<App />, {
    exitOnCtrlC: true,
    ...(hasStdin ? {} : { stdin: undefined }),
  });
}

import React from "react";
import { render } from "ink";

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

  render(<App />, {
    exitOnCtrlC: true,
    ...(hasStdin ? {} : { stdin: undefined }),
  });
}

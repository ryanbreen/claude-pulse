# Claude Pulse

## Project Overview

A TUI dashboard for monitoring active Claude Code sessions across the system. Built with Ink (React for CLI) and TypeScript.

## Architecture

- `src/scanner.ts` - Session detection via `ps` and `lsof`, history from `~/.claude/history.jsonl`
- `src/app.tsx` - Ink TUI with live-updating stats, sparklines, heatmap, session table
- `src/snapshot.ts` - Plain text renderer for `--snapshot` mode
- `src/index.tsx` - Entry point routing between TUI and snapshot modes
- `worker/` - Cloudflare Worker + D1 for persisting session snapshots over time

## Running

- `npm run dev` - Interactive TUI
- `npm run dev -- --snapshot` - One-shot plain text output

## Key Design Decisions

- Session detection uses `ps -eo` for process list + single batched `lsof` call for cwds (fast, ~700ms for 18 sessions)
- All UI elements scale to terminal width via `useStdout().columns`
- Sparklines always resample to fill available width
- 24h heatmap bucket count scales with terminal width
- Stats grid uses fixed column widths (W/5) for alignment across rows

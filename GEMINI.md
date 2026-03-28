# GEMINI Context: marmonitor

`marmonitor` is a local AI agent monitor for terminal-based coding workflows. It provides a CLI and integrations for scanning, enriching, and interacting with running AI coding agents like Claude Code, Codex, and Gemini.

## Project Overview

- **Purpose:** Monitor local AI agent processes, enrich them with session metadata (tokens, CWD, activity phase), and provide terminal-friendly views (Tmux popups, statuslines).
- **Supported Agents:** Claude Code, Codex, Gemini.
- **Main Technologies:** Node.js (18+), TypeScript, Commander.js, `ps-list`, `pidusage`.
- **Primary Surfaces:** Tmux (popups, jumps), WezTerm (status bar), and standard CLI.

## Architecture

- `src/cli.ts`: Entry point, command definitions, and TUI loop logic.
- `src/scanner.ts`: Core logic for discovering agent processes and parsing session data (JSONL files).
- `src/config.ts`: Configuration management, path resolution, and default settings.
- `src/output.ts`: Terminal rendering, statusline formatting, and interactive choosers.
- `src/tmux.ts`: Integration with `tmux` for pane navigation and output capture.
- `src/guard.ts`: Safety evaluator that can block dangerous commands or unauthorized file access.
- `src/utils.ts`: Shared helpers for phase detection and session management.

## Building and Running

- **Install Dependencies:** `npm install`
- **Build:** `npm run build` (uses `tsc`)
- **Run (Development):** `node bin/marmonitor.js [command]`
- **Global Link:** `npm link` then `marmonitor [command]`
- **Test:** `npm test` (uses `node --test`)
- **Lint:** `npm run lint` (uses Biome)

### Key Commands

- `marmonitor status`: One-shot inventory of all discovered AI sessions.
- `marmonitor attention`: Priority list for sessions needing review.
- `marmonitor watch`: Live full-screen monitor.
- `marmonitor --statusline`: One-line summary for Tmux/WezTerm bars.
- `marmonitor jump --attention-index 1`: Jump to a specific agent's Tmux pane.
- `marmonitor settings-init`: Initialize a `settings.json` file.

## Development Conventions

- **Tooling:** Uses Biome for linting and formatting. Adhere to `biome.json` rules.
- **Language:** TypeScript with ESM (`"type": "module"`).
- **Safety:** Always run `npm test` before submitting changes.
- **Performance:** When reading session files (JSONL), use surgical reads/offsets to avoid re-parsing large files (see `src/scanner.ts`).
- **Safety Guard:** Any changes to `guard.ts` or its logic must be rigorously tested as it is a fail-open security feature.
- **Project Structure:**
  - `src/`: TypeScript source files.
  - `bin/marmonitor.js`: CLI entry point (wraps `dist/cli.js`).
  - `tests/`: Automated tests (using Node's native test runner).
  - `examples/`: Integration scripts for Tmux and WezTerm.
  - `src/marmonitor/`: Contains a parallel/legacy Python implementation (use with caution; the TS version is the primary one).

## Configuration

Settings are stored in `settings.json`, searched in order:
1. `$XDG_CONFIG_HOME/marmonitor/settings.json`
2. `~/.config/marmonitor/settings.json`
3. `~/.marmonitor.json` (legacy)

Key configuration groups: `display`, `integration`, `paths`, `status`, `performance`, and `intervention`.

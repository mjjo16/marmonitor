# Architecture

## Overview

marmonitor is a passive, local-first monitoring tool for AI coding agents. It detects running agents by scanning OS processes, enriches sessions with local data (tokens, phases, timestamps), and renders output to various terminal surfaces.

```
Process List (OS)
      │
      ▼
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Scanner  │────▶│  Output  │────▶│ Terminal │
│          │     │          │     │ Surfaces │
│ - detect │     │ - text   │     │ - stdout │
│ - enrich │     │ - JSON   │     │ - tmux   │
│ - phase  │     │ - pills  │     │ - wezterm│
└──────────┘     └──────────┘     └──────────┘
      │
      ▼
┌──────────┐     ┌──────────┐
│  Guard   │     │  Config  │
│          │     │          │
│ - hooks  │     │ - XDG    │
│ - rules  │     │ - merge  │
└──────────┘     └──────────┘
```

## Module Responsibilities

### `scanner.ts` — Process Detection & Enrichment

The core module. It:

1. **Detects** AI processes via `ps-list` (name match, then cmd fallback for Node scripts)
2. **Enriches** with session data by reading agent-specific local files:
   - Claude: `~/.claude/projects/*/sessions/*.jsonl` (tokens, phases, timestamps)
   - Codex: session logs and stdout heuristics
   - Gemini: process-level info only (no session files yet)
3. **Determines status**: Active, Idle, Stalled, Dead, Unmatched
4. **Detects phase**: thinking, tool, permission, done

### `output.ts` — Rendering

Formats `AgentSession[]` into various output forms:

| Function | Used By |
|----------|---------|
| `printStatus()` | `marmonitor status` |
| `printStatusJson()` | `marmonitor status --json` |
| `printDock()` | `marmonitor dock` |
| `printAttention()` | `marmonitor attention` |
| `renderStatusline()` | `marmonitor --statusline` |

### `utils.ts` — Pure Functions

Stateless utilities for formatting, sorting, and building data structures:

- `buildAttentionItems()` — Priority-sorted session list (permission > thinking > recent)
- `buildStatuslineSummary()` — Compact status counts
- `compactDirLabel()` — Path shortening for display
- `formatElapsed()` — Human-readable time deltas

### `config.ts` — Configuration

Loads settings from XDG-compliant paths with deep merge:

```
Priority:
  1. $XDG_CONFIG_HOME/marmonitor/settings.json
  2. ~/.config/marmonitor/settings.json
  3. ~/.marmonitor.json (legacy)
  4. Built-in defaults
```

### `guard.ts` — Hook Evaluation

Evaluates Claude Code hook payloads against intervention rules. Fail-open by design — any error returns `{"decision": "allow"}`.

### `tmux.ts` — tmux Integration

Discovers tmux panes, maps PIDs to pane targets, and executes `select-window`/`select-pane` for jump navigation.

### `banner.ts` — Terminal Banner

Renders the marmonitor banner with iTerm2 inline image protocol (pixel-perfect) or ANSI block art fallback.

## Data Flow

```
1. CLI parses command (commander)
2. Config loaded (XDG merge)
3. Scanner runs:
   a. ps-list → agent process list
   b. For each process: read session files, parse tokens/phases
   c. Determine status (Active/Idle/Stalled/Dead/Unmatched)
4. Output renders the AgentSession[] array
5. For statusline: result cached to /tmp/marmonitor/ with TTL
```

## Key Design Decisions

- **No daemon**: Each invocation is a fresh scan. Caching via temp files with TTL.
- **Fail-safe**: Every external call (ps, tmux, file reads) is wrapped in try-catch. Failures degrade silently.
- **No network**: Zero outbound connections. All data is local.
- **Agent-agnostic**: New agents can be added via config `processNames` + optional enrichment logic.

## Adding Support for a New Agent

See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-ai-agent) for the step-by-step guide.

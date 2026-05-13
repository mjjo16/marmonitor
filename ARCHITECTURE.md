# Architecture

## Overview

marmonitor is a passive, local-first observer for AI coding agents. A long-running daemon scans OS processes, enriches detected agents with session data (tokens, phases, timestamps, git branch), and writes snapshots that all other surfaces (CLI output, tmux statusline, dock, attention popup) consume cheaply.

```
                              ┌──────────────────────────┐
                              │  bin/daemon.js           │
                              │   src/scanner/           │
                              │   daemon-entry.ts        │
                              │       │                  │
ps-list ──┐                   │       ▼                  │
pidusage ─┼─▶ scanAgents() ──▶│  daemon-loop             │
JSONL/SQ ─┘                   │   light 2s   heavy 30s   │
~/.claude/sessions            │       │                  │
~/.codex/sessions/threads.db  │       ▼                  │
~/.gemini/tmp/...             │   write snapshot/regs    │
                              └──────────────────────────┘
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼                               ▼                               ▼
 /tmp/marmonitor/             ~/.config/marmonitor/             ~/.config/marmonitor/
 daemon-snapshot.json         session-registry.json             activity-log/*.jsonl
 alerts-snapshot.json         codex-binding-registry.json       alerts.log
 statusline-*.txt cache
       │
       ▼
 bin/marmonitor.js → src/cli.ts → readDaemonSnapshot → src/output/* → tmux/term
```

## Data Flow

```
1. CLI command parses (commander, src/cli.ts)
2. For most read commands: readDaemonSnapshot() ─ ~ms.
   For one-shot enrichment commands (debug-phase, clean): scanAgents() runs inline.
3. src/output/* renders AgentSession[] → text / JSON / statusline / dock / attention.
4. tmux statusline goes through a two-layer cache:
   a) /tmp/marmonitor/statusline-<format>-<limit>-<width>.txt with TTL
      (TTL = config.performance.statuslineTtlMs, default 2s).
   b) For tmux-badges, the active panePid is stored in the cache header so that
      cache hits invalidate when the focused pane changes.
5. Inside the daemon loop:
   - light scan: ps-list + pidusage + cached enrichment (hot/warm tier)
   - heavy scan (every 30s): full JSONL/SQLite parse (covers cold tier and
     promotes cold sessions when the JSONL mtime advances)
   - guard / alerts hooks fire here (token thresholds, security trigger)
```

## Module Responsibilities

### `src/scanner/index.ts` — `scanAgents()`

Entry point of the scan pipeline.

1. `ps-list` → filter by per-agent `processNames` from config (Electron sub-processes and the VS Code Codex `app-server` are excluded).
2. Batch `pidusage` for CPU/memory.
3. For Codex, pre-resolve cwd and pre-index sessions once (SQLite `threads` + recent JSONL merge).
4. Per process, run agent-specific enrichment (`claude.ts`, `codex.ts`, `gemini.ts`) — gated by **session tier** (`session-tier.ts`):
   - `hot` (≤2 min activity, or live phase) — full enrich every scan.
   - `warm` (≤10 min) — full enrich on heavy scan only.
   - `cold` — cache reused, but JSONL mtime is checked and bumps the session back to hot when changed.
5. `determineStatus` + `applyStatusHysteresis` (`status.ts`) decide Active/Idle/Stalled with a 30s grace window (longer for Codex).
6. `groupByParent` (`group.ts`) merges child PIDs into the parent worker tree.

### Per-agent enrichment

| Module | Identity Resolver | File Binding | Phase Detection |
|--|--|--|--|
| `claude.ts` | `~/.claude/sessions/{pid}.json` → `sessionId` | `<encodedCwd>/<sessionId>.jsonl` direct, with `chooseStaleSessionOverride` to detect `/clear` | tail jsonl, message kinds + decay |
| `codex.ts` + `codex-sqlite.ts` + `codex-binding-registry.ts` | `cwd + processStartedAt` against SQLite thread index | rollout JSONL via persistent binding registry (PID×start) | jsonl tail + `detectCliStdoutPhase` (tmux capture-pane heuristic) |
| `gemini.ts` | `cwd` → `~/.gemini/tmp/<hash>/chats/session-*.json` | latest mtime | session JSON inspection + stdout heuristic |

The Codex binding registry is what keeps long-lived sessions stable across `/clear`, restarts, and multiple sessions in the same `cwd`. Each record carries a confidence and `unstableCount`, and is marked `deadAt` when its PID disappears so that pruning is bounded (default 7 days).

### `src/scanner/daemon-loop.ts`

Long-running loop spawned by `bin/daemon.js`. Responsibilities:

- Two-tier cadence (`intervalMs` light + `detailIntervalMs` heavy).
- Snapshot file writes (`daemon-snapshot.json`, `alerts-snapshot.json`).
- Session registry persistence (`session-registry.json`, 30-day prune).
- Activity log: incremental JSONL cursor per session → `activity-log/YYYY-MM-DD.jsonl`, with daily cleanup.
- Token-threshold alerts via `checkTokenAlert` (per `config.alerts`).
- Memory monitor warns when RSS > 200 MB.
- Graceful shutdown on SIGTERM/SIGINT: flush registries and remove pidfile.

### `src/output/`

Pure render layer over `AgentSession[]`. `index.ts` exposes:

| Function | Used by |
|--|--|
| `printStatus`, `printStatusJson` | `marmonitor status` |
| `printAttention`, `printAttentionJson` | `marmonitor attention` |
| `printDock` | `marmonitor dock` |
| `renderStatusline`, `renderUnavailableStatusline` | `marmonitor --statusline` |
| `printJumpResult`, `printJumpJson`, `renderJumpAttentionChooser` | `attention --interactive` / `jump` |
| `printCleanPlan`, `printCleanJson` | `marmonitor clean` |

`utils.ts` is the side-effect-free home of `buildAttentionItems`, `buildStatuslineSummary`, phase decay helpers, path compaction, and tmux click-token builders. `badge-themes.ts` defines the six rendering styles (`basic` / `basic-mono` / `block` / `block-mono` / `text` / `text-mono`).

### `src/config/index.ts`

XDG-compliant loader with deep merge:

```
1. $XDG_CONFIG_HOME/marmonitor/settings.json
2. ~/.config/marmonitor/settings.json
3. ~/.marmonitor.json (legacy fallback)
4. Built-in defaults
```

`resolveRuntimeDataPaths()` layers env-vars (`MARMONITOR_CLAUDE_HOME`, `MARMONITOR_CLAUDE_PROJECTS`, `MARMONITOR_CLAUDE_SESSIONS`, `MARMONITOR_CODEX_HOME`, `MARMONITOR_CODEX_SESSIONS`) over `paths.*` so users can monitor non-default install locations.

### `src/guard/index.ts`

Evaluates Claude Code hook payloads from stdin.

- Triggers: `dangerous_command`, `prod_path_access`, `secret_access`, `out_of_cwd_write`. Detection is done with conservative regexes that require both option flags and a system path for `rm`, exact suffixes for credential files, etc., to keep false-positive noise low.
- Outcome: `{ decision: "allow" | "block" }` derived from `intervention.rules` (or `intervention.defaultAction`).
- **Fail-open by design** — any error returns `{"decision": "allow"}`. Today the CLI also fans out `dangerous_command` / `secret_access` events into the alerts pipeline (this fan-out is currently inlined in `cli.ts` and slated to move into the guard module).

### `src/tmux/`

- `index.ts` — list panes, build the PID tree from `ps -eo pid=,ppid=`, then match each agent to a pane via PID-tree first, then `cwd` fallback. `jumpToAgent` saves a jump-back anchor and runs `select-window` / `select-pane` (or `switch-client` when inside tmux).
- `jump-anchor.ts` — per-TTY anchor file in `/tmp/marmonitor/jump-anchors.json`, used by `jump-back` and the `↩` indicator on `tmux-badges`.
- `setup.ts` — manages the `marmonitor-tmux` block in `~/.tmux.conf`, with detection for local checkouts vs the TPM-managed plugin.
- `status-click.ts` — parses tmux mouse status range tokens so clicking a numbered pill jumps to that session.

### `src/alerts/`

- `store.ts` — in-memory alerts with deterministic dedup (`type:agentPid:5min-bucket`) and per-type TTL.
- `token.ts` — `checkTokenAlert(store, agent, thresholds)` triggers `context_warn` / `context_critical` against per-model context limits.
- `log.ts`, `snapshot.ts`, `desktop.ts` — disk log appender, JSON snapshot writer, `node-notifier` desktop notification.

The daemon is the primary producer; the guard pipeline is a secondary producer for `security` alerts.

### `src/banner/`

iTerm2 inline-image banner with ANSI block-art fallback. Emitted by `marmonitor banner` and during `--help`/install.

## Key Design Decisions

- **Daemon-first.** As of 0.2.0, every read path consumes `daemon-snapshot.json` (≈1 ms). Without `marmonitor start`, most commands print `Daemon not running. Run: marmonitor start`. One-shot scans live only inside `debug-phase`, `clean`, and the daemon itself.
- **Two-tier scanning.** Light scans keep statusline fresh on a 2-second budget; heavy scans pay the JSONL/SQLite cost. Cold sessions skip heavy work but watch JSONL mtimes so changes promote them back to hot.
- **Persistent bindings.** Codex needs a stable PID-to-thread mapping that survives `/clear`, file-creation lag, and same-cwd parallelism. The binding registry on disk records confidence and prunes dead PIDs after 7 days.
- **Fail-safe.** Every external call (`ps`, `lsof`, `tmux`, file IO) is wrapped in try/catch; cache writes silently swallow errors. The guard returns `allow` on any malformed input.
- **No network.** Zero outbound connections; everything is parsed from local files and OS APIs.
- **Agent-agnostic.** Adding a new agent means adding a `processNames` entry in config plus a `<agent>.ts` enrichment module. The current branching in `scanAgents()` is being tracked for adapter-style refactoring (see `.worklog/issues/post-review-roadmap.md`).

## Extending

To add a new agent:

1. Add an `agents.<name>` entry in `src/config/index.ts` defaults (or via `settings.json`).
2. Implement `src/scanner/<agent>.ts` — at minimum a session resolver and a phase detector. Keep all IO behind try/catch.
3. Wire it into `src/scanner/index.ts` `scanAgents()` enrichment branch.
4. Extend `src/output/` labels/colors and add tests under `tests/<agent>.test.mjs`.
5. Document the data layout in `~/.ai/projects/mjjo/works/work_mjjo_marmonitor/agent-data-spec.md`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor guide.

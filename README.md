<p align="center">
  <img src="docs/banner-ansi.png" alt="marmonitor" width="640">
</p>

<p align="center">
  <strong>tmux status bar monitor for Claude Code, Codex & Gemini — track AI coding sessions in real time</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/marmonitor"><img src="https://img.shields.io/npm/v/marmonitor" alt="npm version"></a>
  <a href="https://github.com/mjjo16/marmonitor/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/marmonitor" alt="license"></a>
  <img src="https://img.shields.io/node/v/marmonitor" alt="node version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="platform">
</p>

<p align="center">
  <b>English</b> | <a href="README.ko.md">한국어</a>
</p>

---

## Why marmonitor?

Running multiple AI coding agents in tmux is now the norm — Claude Code refactoring your backend, Codex writing tests in another pane, Gemini reviewing docs in a third. But as sessions multiply, you hit the same wall:

- You switch to a pane only to find the agent has been waiting for `allow` for 10 minutes
- You forget which window has the Codex session you were just working with
- You have no idea how many tokens you've burned across sessions

**There's no dashboard for this.** You're alt-tabbing between panes, checking each one manually.

**marmonitor** fixes this. One line in your tmux.conf, and your status bar becomes a live control panel for every AI session on your machine.

<p align="center">
  <img src="docs/use_sample.png" alt="marmonitor tmux statusbar" width="640">
  <br>
  <em>Agent counts, phase badges, and numbered attention pills — all in your tmux bar</em>
</p>

### What it does

**tmux statusline** — always visible at the bottom of your terminal:
- Agent counts (`Cl 12`, `Cx 2`, `Gm 1`) — how many sessions are running
- Phase alerts (`⏳ 1`, `🤔 2`, `🔧 1`) — which sessions need attention
- Numbered pills (`1 ⏳Cl my-project allow`, `2 •Cx api-server 6m`) — jump to any session with `Option+1~5`

**Attention priority** — sessions that need your input come first:
- ⏳ `permission` (allow waiting) is always #1 — you need to approve
- 🤔 `thinking` (AI responding) is #2 — result coming soon
- Then most recently active sessions, so you can quickly return to what you were working on

**Quick jump** — press `Option+1` to jump directly to the #1 attention session's tmux pane. No searching through windows.

**Full status** — `marmonitor status` shows everything:

<p align="center">
  <img src="docs/use_status_sample.png" alt="marmonitor status output" width="640">
  <br>
  <em>All sessions with status, tokens, phase, CPU/MEM, and worker process tree</em>
</p>

**Zero instrumentation** — no API keys, no agent plugins, no code changes. marmonitor reads local process info and session files from the outside. Two commands to get started: `npm install -g marmonitor` then `marmonitor setup tmux`.

> **Built for the tmux + AI multi-session workflow.** If you run 5+ AI coding sessions daily across different projects, marmonitor turns context-switching from guesswork into a glance at your status bar.

<details>
<summary><h3>🔩 Under the hood: Agent Session Binding</h3></summary>

### The problem

None of the major AI coding agents expose an external API for session introspection. There's no `claude sessions list`, no webhook when a session changes state. To show you live token counts, phase, and `lastResponseAt`, marmonitor has to read and interpret each agent's internal data formats — which are completely different across agents, undocumented, and subject to change.

But the harder problem isn't parsing files. It's **reliably binding a live OS process to the right session file** — and keeping that binding correct as sessions evolve.

### Why binding is hard

A naïve approach — "find the agent process, read the newest session file" — breaks under common real-world conditions:

- **`/clear` in Claude Code** creates a new session UUID and a new JSONL file while the PID stays the same. Without re-mapping, marmonitor would keep reading the old file and report stale tokens and a frozen `lastResponseAt`.
- **Stale PID metadata** — Claude writes `~/.claude/sessions/{pid}.json` with the current session ID, but after `/clear` this file can lag behind the actual new session for a window of time.
- **Multiple sessions sharing a cwd** — when you run two Claude sessions in the same project directory, mtime-based file selection silently picks the wrong JSONL, misattributing one session's activity to another.
- **Delayed file creation** — a session file may not exist on disk yet when the process is first detected, requiring provisional binding with promotion once the file appears.

Any of these failures corrupts downstream metrics: token usage, phase detection, and `lastResponseAt` all read from the bound file.

### The binding pipeline

For every detected agent process, marmonitor resolves a chain of five steps:

```
PID
 └─ Identity Resolver     → session identity (sessionId or thread index)
     └─ File Binding       → session file path  (direct or provisional)
         └─ Reconciliation → stale/clear correction when needed
             └─ Binding Cache    → in-memory, current binding only
                 └─ Binding History  → disk registry, per-session accumulation
```

Each agent traverses this chain differently:

| | Identity Resolver | File Binding | Reconciliation |
|--|--|--|--|
| **Claude Code** | `~/.claude/sessions/{pid}.json` → `sessionId` | `{sessionId}.jsonl` (direct) or mtime-proximity match (provisional) | `chooseStaleSessionOverride()` detects `/clear` and stale pid metadata |
| **Codex** | `cwd + processStartedAt` matched against SQLite thread index | Rollout JSONL or SQLite row, via binding registry keyed on `pid + processStartedAt` | Freshness correction via binding registry TTL |
| **Gemini** | `cwd` → resolved project dir under `~/.gemini/tmp/` | Latest `chats/session-*.json` by mtime | Lightweight — single active session per project dir |

### Why this matters

The binding layer is what makes the numbers in your status bar trustworthy. A `direct` binding means the file path was confirmed from session metadata — marmonitor won't swap it without evidence. A `provisional` binding is held until a direct file appears, then promoted automatically. Reconciliation only overrides when specific conditions are met (mtime lead, metadata confirmation, active file guard) — not on every scan.

This design is also the reason marmonitor can correctly track sessions across `/clear`, restarts, and parallel sessions in the same project — scenarios where simpler monitors silently fall back to wrong data.

</details>

## Supported Agents

| Agent | Detection | Session Enrichment | Phase Tracking |
|-------|-----------|-------------------|----------------|
| **Claude Code** | Native binary | Tokens, timestamps, model | thinking, tool, permission, done |
| **Codex** | Binary + cmd fallback | Tokens, timestamps, model | thinking, tool, done |
| **Gemini** | cmd fallback | Tokens, timestamps, model | thinking, tool, done |

## Install

### 1. Install marmonitor

```bash
npm install -g marmonitor
```

### 2. Set up tmux integration

```bash
marmonitor setup tmux
```

This adds the [marmonitor-tmux](https://github.com/mjjo16/marmonitor-tmux) plugin to your `~/.tmux.conf`. Then press `prefix + I` inside tmux to activate.

After upgrading `marmonitor`, run:

```bash
marmonitor update-integration
```

This checks whether your tmux integration also needs a TPM/plugin update.

If you updated the TPM plugin with `prefix + U` but click actions or popup keybindings still behave like the old version, re-apply the plugin in the running tmux server:

```bash
tmux run-shell ~/.tmux/plugins/marmonitor-tmux/marmonitor.tmux
```

This mainly affects existing tmux sessions after a plugin upgrade. Fresh installs via `prefix + I` usually load the current bindings immediately.

<details>
<summary>Or add manually to ~/.tmux.conf</summary>

```bash
set -g @plugin 'mjjo16/marmonitor-tmux'
```

Requires [tpm](https://github.com/tmux-plugins/tpm).
</details>

<details>
<summary>Manual install (without tpm)</summary>

```bash
git clone https://github.com/mjjo16/marmonitor-tmux ~/.tmux/plugins/marmonitor-tmux
```

Add to `~/.tmux.conf`:
```bash
run-shell ~/.tmux/plugins/marmonitor-tmux/marmonitor.tmux
```
</details>

<details>
<summary>Install from source (development)</summary>

```bash
git clone https://github.com/mjjo16/marmonitor.git
cd marmonitor
npm install && npm run build
npm link
```
</details>

## Quick Start

### Start the daemon

marmonitor runs as a background daemon that scans your AI sessions every 2 seconds:

```bash
marmonitor start        # Start the daemon
marmonitor stop         # Stop the daemon
marmonitor restart      # Restart (e.g. after npm update)
```

The daemon must be running for all other commands to work. `marmonitor setup tmux` starts it automatically.

### tmux shortcuts

| Shortcut | Action |
|----------|--------|
| `prefix + a` | Attention popup — choose a session to review |
| `prefix + j` | Jump popup — pick a session to jump to |
| `prefix + m` | Dock — compact monitor pane |
| `Option+1~5` | Direct jump to attention session #1~5 |
| `Option+`` | Jump back to previous pane |

### CLI commands

```bash
marmonitor status       # Full session inventory
marmonitor attention    # What needs your input?
marmonitor activity     # What did each session do? (tool calls + tokens)
marmonitor watch        # Live full-screen monitor
marmonitor jump-back    # Return to pane before last jump
marmonitor help         # All commands and options
```

### Activity log

Track what your AI sessions actually did — file edits, bash commands, tokens used:

```bash
marmonitor activity                  # Today's activity
marmonitor activity --pid 1234       # Filter by PID
marmonitor activity --session abc    # Filter by session ID
marmonitor activity --days 3         # Last 3 days
marmonitor activity --json           # JSON output
```

Activity is collected automatically by the daemon and stored in `~/.config/marmonitor/activity-log/` (7-day retention).

## Phase Icons

| Icon | Phase | Meaning |
|------|-------|---------|
| ⏳ | `permission` | AI requesting tool approval — **user input needed** |
| 🤔 | `thinking` | AI generating a response |
| 🔧 | `tool` | Approved tool executing |
| ✅ | `done` | Response complete, awaiting next instruction |

## Status Labels

| Label | Meaning |
|-------|---------|
| `[Active]` | CPU activity detected |
| `[Idle]` | Process alive, no recent activity |
| `[Stalled]` | No activity for extended period |
| `[Dead]` | Session file exists but process is gone |
| `[Unmatched]` | AI process found but no matching session |

## tmux Plugin

The [marmonitor-tmux](https://github.com/mjjo16/marmonitor-tmux) plugin handles all tmux setup automatically:

- 2nd status line with agent badges and attention pills
- Key bindings for popup, jump, and dock
- Option+1~5 direct jump

All settings are customizable via `@marmonitor-*` options. See the [plugin README](https://github.com/mjjo16/marmonitor-tmux) for details.

### Badge styles

tmux badges and terminal text output can share one style via `integration.tmux.badgeStyle`.

- `basic` — default colored pills
- `basic-mono` — monochrome pills with Powerline borders
- `block` — filled background badges without Powerline separator glyphs
- `block-mono` — monochrome filled badges without Powerline separator glyphs
- `text` — plain colored text, no filled background
- `text-mono` — grayscale text only

The currently active tmux pane is also highlighted in the attention pill row so it is easier to see which session belongs to the focused window.

### Alerts

`marmonitor` includes an alert system for important runtime signals such as critical token/context usage and guard-triggered risk events.

Useful commands:

```bash
marmonitor alerts
marmonitor alerts on
marmonitor alerts off
marmonitor alerts notify on
marmonitor alerts notify off
```

Desktop notifications can be enabled separately from alert collection. After changing alert settings, restart the daemon to apply them:

```bash
marmonitor restart
```

## Configuration

Config is loaded from (first found wins):

1. `$XDG_CONFIG_HOME/marmonitor/settings.json`
2. `~/.config/marmonitor/settings.json`
3. `~/.marmonitor.json`

```bash
# View current config path and values
marmonitor settings-path
marmonitor settings-show

# Generate a starter config
marmonitor settings-init --stdout
```

### Example Config

```json
{
  "display": {
    "attentionLimit": 10,
    "statuslineAttentionLimit": 5
  },
  "status": {
    "stalledAfterMin": 20,
    "phaseDecay": {
      "thinking": 20,
      "tool": 30,
      "permission": 0,
      "done": 5
    }
  },
  "integration": {
    "tmux": {
      "badgeStyle": "basic",
      "keys": {
        "attentionPopup": "a",
        "jumpPopup": "j",
        "dockToggle": "m",
        "directJump": ["M-1", "M-2", "M-3", "M-4", "M-5"]
      }
    }
  }
}
```

## Uninstall

```bash
marmonitor uninstall-integration    # Remove tmux settings + restore status bar
npm uninstall -g marmonitor         # Remove CLI
```

## Safety

- **Read-only by default** — observes only, never modifies your sessions
- **No network** — zero outbound connections, all data stays local
- **Conservative defaults** — all integrations are opt-in
- **tmux-first** — terminal-native WezTerm/iTerm2 surfaces are currently paused

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history and breaking changes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commit conventions, and PR guidelines. For architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Known Limitations

- Pane jump requires tmux
- WezTerm / iTerm2 native bars are paused for now; tmux is the supported surface
- Gemini permission detection is limited due to Ink TUI architecture
- Phase detection relies on heuristics — accuracy varies by agent
- macOS first; Linux support is untested

## License

[MIT](LICENSE) — MJ JO

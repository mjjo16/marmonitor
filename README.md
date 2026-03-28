<p align="center">
  <img src="docs/banner-ansi.png" alt="marmonitor" width="480">
</p>

<p align="center">
  <strong>Standing guard over your AI coding sessions</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/marmonitor"><img src="https://img.shields.io/npm/v/marmonitor" alt="npm version"></a>
  <a href="https://github.com/mjjo16/marmonitor/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/marmonitor" alt="license"></a>
  <img src="https://img.shields.io/node/v/marmonitor" alt="node version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue" alt="platform">
</p>

---

## What is marmonitor?

When you run multiple AI coding agents simultaneously — Claude Code in one pane, Codex in another, Gemini in a third — it's hard to know at a glance:

- Which agent is waiting for your approval?
- Which one is actively thinking or running tools?
- How many tokens have been consumed?
- Is anything stalled or stuck?

**marmonitor** answers all of these from your tmux status bar. It passively scans AI agent processes, reads their local session data (tokens, phases, timestamps), and renders a compact live overview — no code changes, no API keys, no cloud.

<p align="center">
  <img src="docs/use_sample.png" alt="marmonitor tmux statusbar" width="640">
  <br>
  <em>tmux status bar showing agent badges, phase icons, and numbered attention pills</em>
</p>

### Key Features

- **Real-time status** — see all AI sessions at a glance (`status`, `watch`, `dock`)
- **Phase tracking** — know when an agent needs approval (⏳), is thinking (🤔), or running tools (🔧)
- **Attention priority** — permission-waiting sessions surface first, then most recently active
- **tmux integration** — statusline badges, popup attention chooser, direct jump by number
- **Token tracking** — input, output, and cache token counts per session
- **Zero instrumentation** — works by reading local process info and session files, no agent modification needed
- **Local-only** — no network, no telemetry, all data stays on your machine

## Supported Agents

| Agent | Detection | Session Enrichment | Phase Tracking |
|-------|-----------|-------------------|----------------|
| **Claude Code** | Native binary | Tokens, timestamps, model | thinking, tool, permission, done |
| **Codex** | Binary + cmd fallback | Tokens, timestamps, model | thinking, tool, done |
| **Gemini** | cmd fallback | Tokens, timestamps, model | thinking, tool, done |

## Install

```bash
npm install -g marmonitor
```

Or from source:

```bash
git clone https://github.com/mjjo16/marmonitor.git
cd marmonitor
npm install && npm run build
npm link
```

## Quick Start

```bash
# Full session inventory
marmonitor status

# Focused attention list — what needs your input?
marmonitor attention

# Long-running monitor
marmonitor watch
marmonitor dock          # compact, for tmux panes

# Jump to a session's tmux pane
marmonitor jump --attention-index 1

# tmux statusline widget
marmonitor --statusline --statusline-format tmux-badges
```

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

## Terminal Integration

### tmux

Add to your `~/.tmux.conf`:

```bash
# Two-line status bar with AI session badges
set -g status-right '#(marmonitor --statusline --statusline-format tmux-badges)'

# Popup attention chooser (prefix + a)
bind a display-popup -E -w 80 -h 20 "marmonitor attention --interactive"

# Direct jump by number (Option+1~5)
bind -n M-1 run-shell "marmonitor jump --attention-index 1"
```

See [`examples/tmux/`](examples/tmux/) for full setup.

### Non-tmux terminal surfaces

WezTerm / iTerm2 terminal-native surfaces are currently paused.

- `marmonitor` is `tmux-first`
- non-tmux bars are not part of the supported default setup right now
- existing WezTerm example files remain in the repo as paused reference material, not active product surface

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

## Safety

- **Read-only by default** — observes only, never modifies your sessions
- **No network** — zero outbound connections, all data stays local
- **Conservative defaults** — all integrations are opt-in
- **tmux-first** — terminal-native WezTerm/iTerm2 surfaces are currently paused

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

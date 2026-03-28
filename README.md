# marmonitor

Local AI agent monitor for coding workflows.

`marmonitor` scans AI coding agent processes on the current machine, enriches them with local session metadata, and renders compact terminal-friendly views for day-to-day operation.

Supported agents today:
- Claude Code
- Codex
- Gemini

Recommended surfaces:
- `tmux` for control workflows (`jump`, popup, direct shortcut)
- `WezTerm` for persistent monitoring bar
- plain CLI for one-shot inspection

## Requirements

- macOS or Linux
- Node.js 18+
- `tmux` recommended for advanced navigation/jump UX

## Install

Local development:

```bash
npm install
npm run build
node bin/marmonitor.js status
```

Local global command via link:

```bash
npm link
marmonitor status
```

Preview the terminal banner:

```bash
marmonitor banner --install
marmonitor banner --runtime --active 3
marmonitor help
```

## Quick Start

One-shot full inventory:

```bash
marmonitor status
marmonitor status --json
```

Focused attention list:

```bash
marmonitor attention
marmonitor attention --interactive
```

Built-in help and shortcut overview:

```bash
marmonitor help
marmonitor help attention
marmonitor settings-path
marmonitor settings-show
marmonitor settings-init --stdout
```

Jump to an existing tmux pane running an AI session:

```bash
marmonitor jump --pid 32683
marmonitor jump --attention-index 1
```

Long-running monitor:

```bash
marmonitor watch
marmonitor dock
```

Statusline output for terminal/tmux integration:

```bash
marmonitor --statusline
marmonitor --statusline --statusline-format tmux-badges
marmonitor --statusline --statusline-format wezterm-pills
marmonitor --statusline --statusline-format tmux-badges --width 120
```

Cleanup unmatched leftovers:

```bash
marmonitor clean
marmonitor clean --kill
```

`clean --kill` is currently an advanced / experimental path. Prefer reviewing `marmonitor clean` output first.

Claude hook guard:

```bash
marmonitor guard
```

## Config

Config search order:

1. `$XDG_CONFIG_HOME/marmonitor/settings.json`
2. `~/.config/marmonitor/settings.json`
3. `~/.marmonitor.json`

Runtime data path overrides:

- env
  - `MARMONITOR_CLAUDE_HOME`
  - `MARMONITOR_CLAUDE_PROJECTS`
  - `MARMONITOR_CLAUDE_SESSIONS`
  - `MARMONITOR_CODEX_HOME`
  - `MARMONITOR_CODEX_SESSIONS`
- `settings.json`
  - `paths.claudeProjects`
  - `paths.claudeSessions`
  - `paths.codexSessions`
  - `paths.extraRoots`

Resolution order:
1. explicit env override
2. `settings.json` path override
3. `MARMONITOR_*_HOME`
4. built-in default under the current home directory

Minimal example:

```json
{
  "display": {
    "showDead": false,
    "sortBy": "cwd",
    "attentionLimit": 10,
    "statuslineAttentionLimit": 5
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

Advanced example:

```json
{
  "status": {
    "stalledAfterMin": 20,
    "phaseDecay": {
      "thinking": 20,
      "tool": 30,
      "permission": 0,
      "done": 5
    },
    "stdoutHeuristic": {
      "approvalPatterns": [
        "would you like to",
        "please approve"
      ],
      "clearPatterns": [
        "applying patch",
        "running tests"
      ]
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
    },
    "wezterm": {
      "enabled": true,
      "statusTtlSec": 15
    },
    "banner": {
      "install": true,
      "runtime": false
    }
  },
  "paths": {
    "claudeProjects": [],
    "claudeSessions": [],
    "codexSessions": [],
    "extraRoots": []
  },
  "performance": {
    "snapshotTtlMs": 5000,
    "statuslineTtlMs": 5000,
    "stdoutHeuristicTtlMs": 5000
  }
}
```

Recommended settings to expose first:
- `display.attentionLimit`
- `display.statuslineAttentionLimit`
- `integration.tmux.keys.*`
- `paths.*` when runtime data discovery needs manual override

Recommended config groups:
- `display` for day-to-day UX tuning
- `integration` for tmux / WezTerm / banner behavior
- `paths` for machine-specific runtime data overrides
- `status` for thresholds and heuristic tuning
- `performance` for cache/refresh tuning
- `intervention` for advanced policy control

Config helpers:

```bash
marmonitor settings-path
marmonitor settings-show
marmonitor settings-init
marmonitor settings-init --advanced
```

## Second Mac Verification

Recommended smoke test on another macOS machine before npm release:

1. install and link

```bash
git clone https://github.com/mjjo16/marmonitor.git
cd marmonitor
npm install
npm run build
npm link
```

2. confirm the command and config helpers

```bash
marmonitor -v
marmonitor help
marmonitor settings-path --json
marmonitor settings-init --stdout
```

3. confirm runtime path discovery

```bash
marmonitor settings-show
marmonitor status --json
```

Check:
- `settings-show` resolves the expected `paths.*`
- `status --json` runs without local path edits
- if Claude/Codex live in non-default locations, set `paths.*` or `MARMONITOR_*`

4. confirm core monitoring flows

```bash
marmonitor status
marmonitor attention
marmonitor watch
```

Check:
- active sessions are discovered
- long-lived commands do not crash immediately
- `Ctrl+C` exits cleanly

5. if tmux is used, confirm tmux-only flows

```bash
marmonitor jump --attention-index 1
marmonitor --statusline --statusline-format tmux-badges --width 120
```

Check:
- jump works only for tmux-backed sessions
- small-width statusline compaction is readable

Known scope:
- macOS first
- Linux may work but is not yet release-verified
- Windows, remote hosts, and WezTerm precise jump are not currently supported

## tmux

Recommended tmux integration snippets live in:

- `examples/tmux/README.md`
- `examples/tmux/toggle-dock.sh`

Current workflow:
- two-line status bar
- popup attention chooser
- direct jump by numbered attention items
- tmux-only precise pane navigation

## WezTerm

WezTerm example adapter lives in:

- `examples/wezterm/marmonitor-status.lua`
- `examples/wezterm/README.md`

Current role:
- monitoring surface
- bottom bar / persistent summary
- no precise pane jump
- banner preview currently falls back to ANSI sprite outside iTerm2

## Safety

Defaults are intentionally conservative:
- intervention is off by default
- terminal integration is opt-in
- `guard` is fail-open on malformed input
- statusline and adapters degrade to fallback text on render failure

Potentially destructive commands:
- `marmonitor clean --kill`

## Known Limitations

- precise jump is effectively `tmux`-only
- WezTerm is a monitoring surface, not a full control surface
- some phase detection relies on heuristics, especially Codex approval prompts
- accuracy is best on the local machine where sessions actually run
- long-running performance is improved, but still under active optimization

## Development

```bash
npm run build
npm test
npm run lint
```

Current quality gate:
- build must pass
- tests must pass
- lint must pass

## License

MIT

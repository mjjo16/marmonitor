# Changelog

All notable changes to marmonitor are documented here.

## [0.2.4] - 2026-04-08

### Added
- **Git branch context** in status and attention views for enriched sessions.
- **Current pane context** on the right side of the tmux statusline.
- **Status table model column** with abbreviated Claude model names and improved worker row alignment.
- **Activity CLI improvements**: default descending order, `--order`, `--lines`, and better `--pid` guidance when no entries exist.
- **Block badge styles**: `block` and `block-mono` badge themes without Powerline glyph separators for terminals/fonts that render Nerd Font arrows poorly.

### Fixed
- Claude Desktop Electron helper processes on Linux are no longer misdetected as Claude Code CLI sessions.
- Claude Code activity logging now resolves the correct session file path.

## [0.2.3] - 2026-04-04

### Added
- **Codex PID-to-thread binding registry** for more stable long-lived session mapping.
- **Session activity log** and CLI views for tool usage and token tracking.

### Fixed
- Codex binding key mismatch between foreground and daemon paths.
- Session continuity and activity freshness stabilization across scans.

## [0.2.2] - 2026-04-03

### Added
- **Session activity log** (`marmonitor activity`): Track tool usage (Edit, Bash, Read, Grep, etc.) and token consumption per session. Daily JSONL files with 7-day auto-cleanup.
- **Codex binding registry**: Stable PID-to-thread mapping for long-lived same-cwd Codex sessions. Prevents session flickering.
- **Codex SQLite enrichment optimization**: Limit enrichment scope to active sessions only, avoiding performance regression in high-density environments.
- **Codex grace period**: Keep Codex sessions Active for 60s after CPU drops to 0% (burst recovery).
- **`debug-phase` binding diagnostics**: Show Codex binding confidence, threadId, and rolloutPath.

### Fixed
- Codex binding key mismatch between foreground and daemon paths (#088)
- Session registry now tracks JSONL paths for continuity (#090)
- Activity log date boundary cleanup uses start-of-day cutoff (#089)

## [0.2.0] - 2026-04-01

### Added
- **Daemon architecture** (`marmonitor start/stop/restart`): Background scan daemon replaces one-shot scanning. All consumers read daemon snapshot (~1ms).
- **Badge theme system**: 4 styles — `basic`, `basic-mono`, `text`, `text-mono`. Configurable via `integration.tmux.badgeStyle` in settings.json.
- **Jump-back** (`marmonitor jump-back`, Option+\`): Return to the tmux pane you were in before jumping. ↩ indicator in statusline.
- **Popup pagination**: Navigate attention items with arrow keys (n/p) in interactive mode.
- **tmux click actions**: Click numbered attention items in statusline to jump directly.
- **Stale attention aging**: Old thinking/tool sessions drop from top attention slots.
- **`update-integration`**: Diagnose tmux plugin state and show update guidance.
- **`daemonIntervalSec`**: Configure light scan interval (1-30, default 2) in settings.json.
- **Codex SQLite indexing**: Replace 7-day directory scan with SQLite `threads` table query. All active sessions indexed regardless of age.
- **Cold session JSONL mtime check**: Detect phase changes in cold sessions within 2s (was 30s).
- **Session registry**: Track sessionId ↔ PID ↔ token mapping with 30-day pruning.
- **MARMONITOR_PERF=1**: Performance instrumentation for scan timing.
- **Differential enrichment**: hot/warm/cold session tiers with different enrichment frequency.

### Changed
- **Breaking**: `marmonitor start` required before use. One-shot scan path removed.
- **Breaking**: `marmonitor daemon start/stop` replaced by `marmonitor start/stop/restart`.
- npm publish switched to OIDC Trusted Publisher (no NPM_TOKEN needed).
- Publish workflow upgraded to Node 24 for npm provenance support.

### Fixed
- Codex sessions created 7+ days ago no longer become Unmatched (#12)
- fd leak prevention in JSONL reader (try/finally)
- Orphaned test file for deleted enrichment-file-cache.ts

### Removed
- `snapshot-lock.ts` — daemon is single writer, lock unnecessary
- `enrichment-file-cache.ts` — dead code, never imported

### Performance
- statusline: 117ms → 47ms (2.5x faster)
- status: 480ms → 73ms (6.5x faster)
- Worst case spike: 468ms → eliminated
- Codex sessions indexed: 2/49 → 49/49

## [0.1.7] - 2026-03-29

### Added
- tmux plugin setup (`marmonitor setup tmux`)
- Direct jump (Option+1..5)
- Attention interactive popup
- Dock mode
- Claude hook guard
- npm global install with postinstall/preuninstall scripts

## [0.1.0] - 2026-03-24

### Added
- Initial release
- Claude Code, Codex, Gemini session detection
- Token usage tracking
- Phase detection (permission, thinking, tool, done)
- tmux statusline integration

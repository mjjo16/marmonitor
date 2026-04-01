## Description

After upgrading `marmonitor` and updating the `marmonitor-tmux` TPM plugin, the running tmux server can keep the old plugin bindings in memory. The status line may update, but click handling and popup keybindings can still use the previous behavior until the plugin is re-applied manually.

## Steps to Reproduce

1. Install `marmonitor`, set up tmux integration, and activate the TPM plugin.
2. Upgrade `marmonitor` and update `marmonitor-tmux` with `prefix + U` or `git -C ~/.tmux/plugins/marmonitor-tmux pull --ff-only`.
3. In the existing tmux session, try statusline click actions or `prefix + j`.

## Expected Behavior

After the TPM/plugin update, the running tmux session should use the latest plugin bindings immediately, including statusline click handling and the current popup keybindings.

## Actual Behavior

The plugin files on disk are updated, but the running tmux server still uses older bindings. In the reproduced case:

- `status-format[1]` already pointed to `marmonitor-tmux/scripts/statusline.sh`
- `MouseDown1Status` still resolved to the old default binding
- `prefix + j` still resolved to `select-pane -D`
- Running `tmux run-shell ~/.tmux/plugins/marmonitor-tmux/marmonitor.tmux` fixed the issue immediately

## Environment

- **OS**: macOS
- **Node.js**: unknown
- **marmonitor**: 0.2.0
- **Terminal**: unknown
- **tmux**: installed, existing server session active during upgrade

## AI Agents Running

- [ ] Claude Code
- [x] Codex
- [ ] Gemini CLI
- [ ] Other: ___

## Additional Context

This appears to affect upgrade paths more than first-time installation. Fresh installs via `prefix + I` usually load the current bindings immediately because the plugin is being sourced for the first time. Existing users who update the TPM plugin while keeping the same tmux server alive are more likely to hit the stale-binding state.

Suggested user-facing workaround:

```bash
tmux run-shell ~/.tmux/plugins/marmonitor-tmux/marmonitor.tmux
```

Suggested product improvement:

- Make `marmonitor update-integration` print the explicit `tmux run-shell` recovery command
- Add troubleshooting notes to the main README and `marmonitor-tmux` README

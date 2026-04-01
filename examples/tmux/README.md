# tmux integration snippets

## Two-line status bar

Current recommended tmux setup uses:

- line 1: existing tmux status content
- line 2: `marmonitor` badge row + numbered direct-jump attention pills

Example:

```tmux
set -g status 2
set -g status-format[1] "#[bg=#1e1e2e]#[fg=#cdd6f4]  #(cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js --statusline --statusline-format tmux-badges --width \"#{window_width}\") "
```

- `--width "#{window_width}"` lets `marmonitor` compact long paths and reduce attention items only when the tmux client becomes narrow

## Right dock toggle

Bind a key to toggle the compact dock pane:

```tmux
bind-key M run-shell "bash ~/Documents/mjjo/marmonitor/examples/tmux/toggle-dock.sh"
```

This toggles a 36-column right pane running:

```bash
node bin/marmonitor.js dock --lines 12
```

## Attention popup

Popup-friendly attention list:

```tmux
bind-key A display-popup -E -w 70 -h 18 "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js attention --limit 12"
```

## Interactive attention jump popup

Choose one attention item and jump directly from the popup:

```tmux
bind-key A display-popup -E -w 120 -h 42 "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js attention --interactive --limit 12"
```

- shows only jumpable items
- by default follows `display.attentionLimit` from `settings.json`
- when more than 10 items exist, use `←` / `→` to move pages
- page indicator uses `< 1/2 >` style in the popup header
- press `1-9` to jump
- press `0` for `10`
- press `q` to cancel

## Interactive jump popup

Choose one attention item and jump to its existing pane:

```tmux
bind-key J display-popup -E -w 120 -h 42 "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump --attention"
```

- when more than 10 items exist, use `←` / `→` to move pages
- press `1-9` to jump
- press `0` for `10`
- press `q` to cancel

## Jump to existing pane

Jump to the tmux pane already running a specific AI PID:

```bash
node bin/marmonitor.js jump --pid 32683
```

This prefers tmux `pane_pid` descendant matching and falls back to exact `cwd` match.

## Direct jump by attention index

Jump directly to the Nth jumpable attention item:

```bash
node bin/marmonitor.js jump --attention-index 1
```

Recommended tmux bindings without prefix:

```tmux
bind-key -n M-1 run-shell -b "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump --attention-index 1 >/dev/null 2>&1"
bind-key -n M-2 run-shell -b "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump --attention-index 2 >/dev/null 2>&1"
bind-key -n M-3 run-shell -b "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump --attention-index 3 >/dev/null 2>&1"
bind-key -n M-4 run-shell -b "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump --attention-index 4 >/dev/null 2>&1"
bind-key -n M-5 run-shell -b "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump --attention-index 5 >/dev/null 2>&1"
```

- jump order follows `permission -> thinking -> tool -> stalled`
- unmatched/orphan processes are excluded because they cannot be jumped to
- status bar shows matching numbered pills `1..5`
- on macOS this usually maps to `Option + 1..5`
- `run-shell -b` + output redirection is intentional so tmux does not show a temporary `Jumped to ...` screen

## Jump-back

Return to the pane you were in before the current marmonitor jump chain:

```bash
node bin/marmonitor.js jump-back
```

Recommended tmux binding without prefix:

```tmux
bind-key -n M-6 run-shell -b "cd ~/Documents/mjjo/marmonitor && node bin/marmonitor.js jump-back >/dev/null 2>&1"
```

- current behavior keeps the **first pane before the jump chain**
- repeated `Option+1..5` jumps do not overwrite that origin
- after successful jump-back, the anchor is cleared

## Statusline click interaction

When using the tmux plugin, the second statusline row can be clicked:

- click attention pills to jump to that session
- click the `↩` pill to trigger jump-back

## Notes

- `tmux-badges` is optimized for tmux status bar rendering
- current badge row shows agent counts, attention counts, and up to 5 numbered jumpable sessions
- navigation is tmux-only
- `jump --pid`, `jump --attention`, `jump --attention-index`, and `attention --interactive` are all implemented

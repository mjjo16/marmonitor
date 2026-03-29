#!/usr/bin/env node

/**
 * postinstall script — show install guide.
 * Runs after `npm install -g marmonitor`.
 *
 * npm suppresses stdout from postinstall scripts by default.
 * Using stderr to ensure the message is always visible.
 */

const msg = `
  ✓ marmonitor v${require("../package.json").version} installed
  Monitor Claude Code, Codex & Gemini sessions from your tmux status bar.

  Setup:
    $ marmonitor setup tmux       Add tmux plugin to ~/.tmux.conf
    Then press prefix+I in tmux to activate.

  Commands:
    $ marmonitor status           Show all AI sessions
    $ marmonitor attention        Sessions needing your input
    $ marmonitor help             All commands and shortcuts

  Uninstall:
    $ marmonitor uninstall-integration
    $ npm uninstall -g marmonitor
`;

process.stderr.write(msg + "\n");

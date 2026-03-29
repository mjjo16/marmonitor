#!/usr/bin/env node

/**
 * postinstall script — show install banner + setup guide.
 * Runs after `npm install -g marmonitor`.
 *
 * npm postinstall runs with stdin as pipe (non-TTY),
 * so interactive prompts are not possible here.
 * Actual tmux setup is done via `marmonitor setup tmux`.
 */

console.log("");
console.log("  ✓ marmonitor installed");
console.log("  Standing guard over your AI coding sessions");
console.log("");
console.log("  Quick start:");
console.log("    $ marmonitor setup tmux    — auto-configure tmux integration");
console.log("    $ marmonitor status        — show active AI sessions");
console.log("    $ marmonitor help          — all commands and shortcuts");
console.log("");

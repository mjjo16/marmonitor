#!/usr/bin/env node

/**
 * postinstall script — show install guide.
 * Runs after `npm install -g marmonitor`.
 *
 * npm suppresses stdout from postinstall scripts by default.
 * Using stderr to ensure the message is always visible.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// Restart daemon if it was running (picks up new version)
const pidPath = path.join(os.tmpdir(), "marmonitor", "daemon.pid");
let daemonWasRunning = false;
try {
  const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
  if (!isNaN(pid)) {
    process.kill(pid, "SIGTERM");
    daemonWasRunning = true;
  }
} catch {
  // not running
}

if (daemonWasRunning) {
  // Brief delay then start new daemon
  setTimeout(() => {
    try {
      const { fork } = require("child_process");
      const daemonScript = path.join(__dirname, "..", "dist", "scanner", "daemon-entry.js");
      // Only restart if the compiled entry exists (dist may not exist in dev)
      if (fs.existsSync(daemonScript)) {
        const child = fork(path.join(__dirname, "daemon.js"), [], { detached: true, stdio: "ignore" });
        child.unref();
        process.stderr.write(`  marmonitor: daemon restarted (PID: ${child.pid})\n`);
      }
    } catch {
      process.stderr.write("  marmonitor: daemon restart failed — run: marmonitor start\n");
    }
  }, 500);
}

const msg = `
  ✓ marmonitor v${require("../package.json").version} installed
  Monitor Claude Code, Codex & Gemini sessions from your tmux status bar.

  Quick start:
    $ marmonitor start            Start background daemon
    $ marmonitor setup tmux       Add tmux plugin to ~/.tmux.conf
    Then press prefix+I in tmux to activate.

  Commands:
    $ marmonitor status           Show all AI sessions
    $ marmonitor attention        Sessions needing your input
    $ marmonitor help             All commands and shortcuts

  Uninstall:
    $ marmonitor stop
    $ marmonitor uninstall-integration
    $ npm uninstall -g marmonitor
`;

process.stderr.write(msg + "\n");

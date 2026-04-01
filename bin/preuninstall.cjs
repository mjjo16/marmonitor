#!/usr/bin/env node

/**
 * preuninstall script — remove marmonitor plugin line from tmux.conf.
 * Runs before `npm uninstall -g marmonitor`.
 *
 * Uses only CommonJS-compatible built-ins (no ESM import).
 * Must never fail — errors are silently ignored.
 */

try {
  const fs = require("fs");
  const path = require("path");
  const os = require("os");

  // Stop daemon if running
  const pidPath = path.join(os.tmpdir(), "marmonitor", "daemon.pid");
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, "SIGTERM");
      fs.unlinkSync(pidPath);
      console.log("  marmonitor: daemon stopped");
    }
  } catch {
    // daemon not running or already stopped
  }

  // Remove tmux plugin line
  const PLUGIN_LINE = "set -g @plugin 'mjjo16/marmonitor-tmux'";
  const confPath = path.join(os.homedir(), ".tmux.conf");

  const content = fs.readFileSync(confPath, "utf-8");
  const lines = content.split("\n");
  const filtered = lines.filter((line) => line.trim() !== PLUGIN_LINE);

  if (filtered.length < lines.length) {
    fs.writeFileSync(confPath, filtered.join("\n"), "utf-8");
    console.log("  marmonitor: removed tmux plugin line from ~/.tmux.conf");
  }
} catch {
  // silent — preuninstall must never block npm uninstall
}

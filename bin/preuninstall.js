#!/usr/bin/env node

/**
 * preuninstall script — remove marmonitor plugin line from tmux.conf.
 * Runs before `npm uninstall -g marmonitor`.
 *
 * - No prompt — automatic cleanup
 * - Only removes the exact plugin line, nothing else
 * - Silent if no tmux.conf or no plugin line found
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_LINE = "set -g @plugin 'mjjo16/marmonitor-tmux'";
const CONF_PATH = join(homedir(), ".tmux.conf");

function removePlugin() {
  let content;
  try {
    content = readFileSync(CONF_PATH, "utf-8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  const filtered = lines.filter((line) => line.trim() !== PLUGIN_LINE);

  if (filtered.length === lines.length) return false;

  writeFileSync(CONF_PATH, filtered.join("\n"), "utf-8");
  return true;
}

try {
  const removed = removePlugin();
  if (removed) {
    console.log("  marmonitor: removed tmux plugin line from ~/.tmux.conf");
  }
} catch {
  // preuninstall must never fail the npm uninstall
}

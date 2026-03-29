#!/usr/bin/env node

/**
 * postinstall script — show banner + offer tmux setup.
 * Runs after `npm install -g marmonitor`.
 *
 * - Non-TTY (CI): banner only, no prompt
 * - No tmux: banner + CLI-only message
 * - Already configured: banner + "already configured"
 * - Interactive: banner + y/n prompt → add plugin line to tmux.conf
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PLUGIN_LINE = "set -g @plugin 'mjjo16/marmonitor-tmux'";
const CONF_PATH = join(homedir(), ".tmux.conf");

function hasTmux() {
  try {
    execSync("which tmux", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasPlugin() {
  try {
    const content = readFileSync(CONF_PATH, "utf-8");
    return content.split("\n").some((line) => line.trim() === PLUGIN_LINE);
  } catch {
    return false;
  }
}

function addPlugin() {
  let existing = "";
  try {
    existing = readFileSync(CONF_PATH, "utf-8");
  } catch {
    // file doesn't exist — will create
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(CONF_PATH, `${existing}${sep}${PLUGIN_LINE}\n`, "utf-8");
}

function printBanner() {
  console.log("");
  console.log("  ✓ marmonitor installed");
  console.log("  Standing guard over your AI coding sessions");
  console.log("");
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  printBanner();

  // Non-interactive (CI, piped, etc.)
  if (!process.stdin.isTTY) {
    console.log("  Run 'marmonitor setup tmux' to configure tmux integration.");
    console.log("");
    return;
  }

  // No tmux
  if (!hasTmux()) {
    console.log("  tmux not found. marmonitor CLI is ready:");
    console.log("    $ marmonitor status");
    console.log("    $ marmonitor help");
    console.log("");
    return;
  }

  // Already configured
  if (hasPlugin()) {
    console.log("  tmux integration already configured.");
    console.log("  Press prefix+I in tmux to update the plugin.");
    console.log("");
    return;
  }

  // Interactive prompt
  const answer = await ask("  Set up tmux integration? (y/n): ");

  if (answer === "y" || answer === "yes") {
    addPlugin();
    console.log("");
    console.log("  ✓ Added to ~/.tmux.conf");
    console.log("  Press prefix+I inside tmux to activate.");
    console.log("");
  } else {
    console.log("");
    console.log("  Skipped. You can set up later:");
    console.log("    $ marmonitor setup tmux");
    console.log("");
  }
}

main().catch(() => {
  // postinstall must never fail the npm install
  process.exit(0);
});

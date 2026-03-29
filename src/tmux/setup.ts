/**
 * tmux.conf plugin line management.
 * Adds/removes the marmonitor-tmux tpm plugin line.
 */

import { readFile, writeFile } from "node:fs/promises";

const PLUGIN_LINE = "set -g @plugin 'mjjo16/marmonitor-tmux'";

function matchesPluginLine(line: string): boolean {
  return line.trim() === PLUGIN_LINE;
}

export async function hasMarmonitorPlugin(confPath: string): Promise<boolean> {
  try {
    const content = await readFile(confPath, "utf-8");
    return content.split("\n").some(matchesPluginLine);
  } catch {
    return false;
  }
}

export async function addMarmonitorPlugin(confPath: string): Promise<boolean> {
  if (await hasMarmonitorPlugin(confPath)) return false;

  let existing = "";
  try {
    existing = await readFile(confPath, "utf-8");
  } catch {
    // file doesn't exist yet — will create
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(confPath, `${existing}${separator}${PLUGIN_LINE}\n`, "utf-8");
  return true;
}

export async function removeMarmonitorPlugin(confPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(confPath, "utf-8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  const filtered = lines.filter((line) => !matchesPluginLine(line));

  if (filtered.length === lines.length) return false;

  await writeFile(confPath, filtered.join("\n"), "utf-8");
  return true;
}

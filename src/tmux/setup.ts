/**
 * tmux.conf plugin line management.
 * Adds/removes the marmonitor-tmux tpm plugin line.
 */

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_LINE = "set -g @plugin 'mjjo16/marmonitor-tmux'";

export type TmuxIntegrationMode = "local" | "tpm" | "missing" | "not_git";

function matchesPluginLine(line: string): boolean {
  return line.trim() === PLUGIN_LINE;
}

export function getMarmonitorPluginDir(home: string = homedir()): string {
  return join(home, ".tmux", "plugins", "marmonitor-tmux");
}

export async function hasInstalledMarmonitorPlugin(pluginDir: string): Promise<boolean> {
  try {
    await access(join(pluginDir, "marmonitor.tmux"), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectTmuxIntegrationMode(
  confPath: string,
  pluginDir: string,
): Promise<TmuxIntegrationMode | undefined> {
  let content = "";
  if (!(await hasInstalledMarmonitorPlugin(pluginDir))) {
    try {
      content = await readFile(confPath, "utf-8");
    } catch {
      return undefined;
    }
    if (content.includes("marmonitor-tmux/marmonitor.tmux")) {
      return "local";
    }
    if (content.split("\n").some(matchesPluginLine)) {
      return "missing";
    }
    return undefined;
  }

  try {
    await access(join(pluginDir, ".git"), constants.F_OK);
    return "tpm";
  } catch {
    return "not_git";
  }
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

/**
 * Jump-back anchor management.
 * Saves the current tmux pane location before jumping, so the user can return.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface JumpAnchorLocation {
  session: string;
  window: string;
  pane: string;
}

export interface JumpAnchor extends JumpAnchorLocation {
  savedAt: number;
}

async function readAnchors(anchorPath: string): Promise<Record<string, JumpAnchor>> {
  try {
    const raw = await readFile(anchorPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAnchors(
  anchorPath: string,
  anchors: Record<string, JumpAnchor>,
): Promise<void> {
  await mkdir(dirname(anchorPath), { recursive: true });
  await writeFile(anchorPath, JSON.stringify(anchors, null, 2), "utf-8");
}

export async function saveJumpAnchor(
  anchorPath: string,
  clientTty: string,
  location: JumpAnchorLocation,
): Promise<void> {
  const anchors = await readAnchors(anchorPath);
  anchors[clientTty] = { ...location, savedAt: Date.now() };
  await writeAnchors(anchorPath, anchors);
}

export async function saveJumpAnchorIfMissing(
  anchorPath: string,
  clientTty: string,
  location: JumpAnchorLocation,
): Promise<boolean> {
  const anchors = await readAnchors(anchorPath);
  if (anchors[clientTty]) return false;
  anchors[clientTty] = { ...location, savedAt: Date.now() };
  await writeAnchors(anchorPath, anchors);
  return true;
}

export async function loadJumpAnchor(
  anchorPath: string,
  clientTty: string,
): Promise<JumpAnchor | undefined> {
  try {
    const anchors = await readAnchors(anchorPath);
    return anchors[clientTty] ?? undefined;
  } catch {
    return undefined;
  }
}

export async function clearJumpAnchor(anchorPath: string, clientTty: string): Promise<boolean> {
  const anchors = await readAnchors(anchorPath);
  if (!anchors[clientTty]) return false;
  delete anchors[clientTty];
  await writeAnchors(anchorPath, anchors);
  return true;
}

/** Get the current tmux pane location for the active client */
export async function getCurrentTmuxLocation(): Promise<JumpAnchorLocation | undefined> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "display-message",
      "-p",
      "#{session_name}\t#{window_index}\t#{session_name}:#{window_index}.#{pane_index}",
    ]);
    const [session, window, pane] = stdout.trim().split("\t");
    if (session && window && pane) return { session, window, pane };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Get the client tty of the current tmux client */
export async function getClientTty(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "#{client_tty}"]);
    const tty = stdout.trim();
    return tty || undefined;
  } catch {
    return undefined;
  }
}

/** Jump back to a saved anchor location */
export async function jumpBack(
  anchorPath: string,
  clientTty: string,
): Promise<{ success: boolean; message: string }> {
  const anchor = await loadJumpAnchor(anchorPath, clientTty);
  if (!anchor) {
    return { success: false, message: "No jump-back anchor found." };
  }

  try {
    const windowTarget = `${anchor.session}:${anchor.window}`;
    if (process.env.TMUX) {
      await execFileAsync("tmux", ["switch-client", "-t", windowTarget]);
    }
    await execFileAsync("tmux", ["select-window", "-t", windowTarget]);
    await execFileAsync("tmux", ["select-pane", "-t", anchor.pane]);
    await clearJumpAnchor(anchorPath, clientTty).catch(() => {});
    return { success: true, message: `Jumped back to ${anchor.pane}.` };
  } catch {
    return { success: false, message: `Failed to jump back to ${anchor.pane}.` };
  }
}

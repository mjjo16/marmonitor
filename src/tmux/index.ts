import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { profileAsync } from "../perf.js";
import type { AgentSession } from "../types.js";

const execFileAsync = promisify(execFile);

export interface TmuxPane {
  target: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  panePid: number;
  cwd: string;
}

export interface TmuxJumpTarget {
  pane: TmuxPane;
  match: "pid-tree" | "cwd";
}

export interface TmuxRuntimeSnapshot {
  panes: TmuxPane[];
  childMap: Map<number, number[]>;
}

interface TmuxRuntimeSnapshotLoaders {
  listPanes?: () => Promise<TmuxPane[]>;
  getProcessTree?: () => Promise<Map<number, number[]>>;
}

export interface TmuxJumpResult {
  found: boolean;
  executed: boolean;
  insideTmux: boolean;
  pid: number;
  match?: "pid-tree" | "cwd";
  target?: string;
  sessionName?: string;
  cwd?: string;
  message?: string;
}

export function parseTmuxPanes(raw: string): TmuxPane[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [target, panePidRaw, cwd] = line.split("\t");
      if (!target || !panePidRaw || !cwd) return [];
      const [sessionName, coords] = target.split(":");
      if (!sessionName || !coords) return [];
      const [windowIndexRaw, paneIndexRaw] = coords.split(".");
      if (!windowIndexRaw || !paneIndexRaw) return [];
      const pane = {
        target,
        sessionName,
        windowIndex: Number.parseInt(windowIndexRaw, 10),
        paneIndex: Number.parseInt(paneIndexRaw, 10),
        panePid: Number.parseInt(panePidRaw, 10),
        cwd,
      } satisfies TmuxPane;
      return Number.isFinite(pane.panePid) ? [pane] : [];
    })
    .filter((pane) => Number.isFinite(pane.panePid));
}

export function parseProcessTree(raw: string): Map<number, number[]> {
  const childMap = new Map<number, number[]>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pidRaw, ppidRaw] = trimmed.split(/\s+/);
    const pid = Number.parseInt(pidRaw, 10);
    const ppid = Number.parseInt(ppidRaw, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const children = childMap.get(ppid) ?? [];
    children.push(pid);
    childMap.set(ppid, children);
  }

  return childMap;
}

export function isPidInTree(
  rootPid: number,
  targetPid: number,
  childMap: Map<number, number[]>,
): boolean {
  if (rootPid === targetPid) return true;
  const queue = [...(childMap.get(rootPid) ?? [])];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    if (pid === targetPid) return true;
    seen.add(pid);
    queue.push(...(childMap.get(pid) ?? []));
  }

  return false;
}

export function selectTmuxPaneForAgent(
  agent: Pick<AgentSession, "pid" | "cwd">,
  panes: TmuxPane[],
  childMap: Map<number, number[]>,
): TmuxJumpTarget | undefined {
  const treeMatch = panes.find((pane) => isPidInTree(pane.panePid, agent.pid, childMap));
  if (treeMatch) {
    return { pane: treeMatch, match: "pid-tree" };
  }

  const cwdMatch = panes.find((pane) => pane.cwd === agent.cwd);
  if (cwdMatch) {
    return { pane: cwdMatch, match: "cwd" };
  }

  return undefined;
}

let tmuxRuntimeSnapshotPromise: Promise<TmuxRuntimeSnapshot> | undefined;

export async function listTmuxPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await profileAsync("tmux", "list_panes", () =>
      execFileAsync("tmux", [
        "list-panes",
        "-a",
        "-F",
        "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_path}",
      ]),
    );
    return parseTmuxPanes(stdout);
  } catch {
    return [];
  }
}

export async function getProcessTree(): Promise<Map<number, number[]>> {
  try {
    const { stdout } = await profileAsync("tmux", "process_tree", () =>
      execFileAsync("ps", ["-eo", "pid=,ppid="]),
    );
    return parseProcessTree(stdout);
  } catch {
    return new Map();
  }
}

export async function getTmuxRuntimeSnapshot(
  loaders: TmuxRuntimeSnapshotLoaders = {},
): Promise<TmuxRuntimeSnapshot> {
  if (tmuxRuntimeSnapshotPromise) {
    return await tmuxRuntimeSnapshotPromise;
  }

  const loadPanes = loaders.listPanes ?? listTmuxPanes;
  const loadProcessTree = loaders.getProcessTree ?? getProcessTree;
  const snapshotPromise = profileAsync("tmux", "resolve_snapshot", async () => {
    const [panes, childMap] = await Promise.all([loadPanes(), loadProcessTree()]);
    return { panes, childMap };
  });
  tmuxRuntimeSnapshotPromise = snapshotPromise;

  try {
    return await snapshotPromise;
  } finally {
    if (tmuxRuntimeSnapshotPromise === snapshotPromise) {
      tmuxRuntimeSnapshotPromise = undefined;
    }
  }
}

export function resetTmuxRuntimeSnapshotForTests(): void {
  tmuxRuntimeSnapshotPromise = undefined;
}

export async function resolveTmuxJumpTarget(
  agent: Pick<AgentSession, "pid" | "cwd">,
  loaders: TmuxRuntimeSnapshotLoaders = {},
): Promise<TmuxJumpTarget | undefined> {
  try {
    const { panes, childMap } = await profileAsync("tmux", "resolve_jump_target", () =>
      getTmuxRuntimeSnapshot(loaders),
    );
    return selectTmuxPaneForAgent(agent, panes, childMap);
  } catch {
    return undefined;
  }
}

export async function captureTmuxPaneOutput(
  target: TmuxJumpTarget,
  lines = 30,
): Promise<string | undefined> {
  try {
    const { stdout } = await profileAsync("tmux", "capture_pane", () =>
      execFileAsync("tmux", ["capture-pane", "-p", "-t", target.pane.target, "-S", `-${lines}`]),
    );
    return stdout;
  } catch {
    return undefined;
  }
}

export async function jumpToTmuxPane(target: TmuxJumpTarget): Promise<boolean> {
  const windowTarget = `${target.pane.sessionName}:${target.pane.windowIndex}`;

  try {
    if (process.env.TMUX) {
      await profileAsync("tmux", "switch_client", () =>
        execFileAsync("tmux", ["switch-client", "-t", windowTarget]),
      );
      await profileAsync("tmux", "select_window", () =>
        execFileAsync("tmux", ["select-window", "-t", windowTarget]),
      );
      await profileAsync("tmux", "select_pane", () =>
        execFileAsync("tmux", ["select-pane", "-t", target.pane.target]),
      );
      return true;
    }

    await profileAsync("tmux", "select_window", () =>
      execFileAsync("tmux", ["select-window", "-t", windowTarget]),
    );
    await profileAsync("tmux", "select_pane", () =>
      execFileAsync("tmux", ["select-pane", "-t", target.pane.target]),
    );
    return true;
  } catch {
    return false;
  }
}

export async function jumpToAgent(
  agent: Pick<AgentSession, "pid" | "cwd">,
): Promise<TmuxJumpResult> {
  const target = await resolveTmuxJumpTarget(agent);
  if (!target) {
    return {
      found: false,
      executed: false,
      insideTmux: Boolean(process.env.TMUX),
      pid: agent.pid,
      cwd: agent.cwd,
      message: "No tmux pane matched this AI session.",
    };
  }

  const executed = await jumpToTmuxPane(target);
  return {
    found: true,
    executed,
    insideTmux: Boolean(process.env.TMUX),
    pid: agent.pid,
    match: target.match,
    target: target.pane.target,
    sessionName: target.pane.sessionName,
    cwd: target.pane.cwd,
    message: executed
      ? `Switched to ${target.pane.target} via ${target.match}.`
      : `Matched ${target.pane.target} via ${target.match}, but tmux switch failed.`,
  };
}

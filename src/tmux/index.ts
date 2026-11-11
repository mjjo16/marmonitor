import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentSession } from "../types.js";
import { getClientTty, getCurrentTmuxLocation, saveJumpAnchorIfMissing } from "./jump-anchor.js";

const execFileAsync = promisify(execFile);

export interface TmuxPane {
  target: string;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  panePid: number;
  cwd: string;
  paneId?: string;
}

export interface TmuxJumpTarget {
  pane: TmuxPane;
  match: "pid-tree" | "tty" | "cwd";
}

export interface TmuxJumpResult {
  found: boolean;
  executed: boolean;
  insideTmux: boolean;
  pid: number;
  match?: "pid-tree" | "tty" | "cwd";
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
      const [target, panePidRaw, cwd, paneId] = line.split("\t");
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
        ...(paneId && /^%\d+$/.test(paneId) ? { paneId } : {}),
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
  ttys: ReadonlyMap<number, string> = new Map(),
  allowCwdFallback = true,
): TmuxJumpTarget | undefined {
  // Linked windows can expose the same physical pane through multiple paths.
  const uniquePanes = [
    ...new Map(panes.map((pane) => [pane.paneId ?? pane.panePid, pane])).values(),
  ];
  const treeMatches = uniquePanes.filter((pane) => isPidInTree(pane.panePid, agent.pid, childMap));
  if (treeMatches.length === 1) {
    return { pane: treeMatches[0], match: "pid-tree" };
  }
  if (treeMatches.length > 1) return undefined;

  const tty = ttys.get(agent.pid);
  if (tty && /^\/dev\/(?:tty[^/]*|pts\/\d+|pty[^/]*)$/.test(tty)) {
    const ttyMatches = uniquePanes.filter((pane) => ttys.get(pane.panePid) === tty);
    if (ttyMatches.length === 1) return { pane: ttyMatches[0], match: "tty" };
    if (ttyMatches.length > 1) return undefined;
  }

  const cwdMatches = allowCwdFallback ? uniquePanes.filter((pane) => pane.cwd === agent.cwd) : [];
  if (cwdMatches.length === 1) {
    return { pane: cwdMatches[0], match: "cwd" };
  }

  return undefined;
}

export async function listTmuxPanes(): Promise<TmuxPane[]> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_path}\t#{pane_id}",
    ]);
    return parseTmuxPanes(stdout);
  } catch {
    return [];
  }
}

export async function getProcessTree(): Promise<Map<number, number[]>> {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="]);
    return parseProcessTree(stdout);
  } catch {
    return new Map();
  }
}

/** Get the PID of the currently active tmux pane */
export async function getActiveTmuxPanePid(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("tmux", ["display-message", "-p", "#{pane_pid}"]);
    const pid = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Get the controlling tty of a PID via lsof (`-d 0` reads stdin fd → tty).
 *  Uses lsof instead of `ps -o tty=` because the latter returns EPERM on
 *  macOS for processes the caller does not own in the same session. */
export async function getProcessTty(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "0", "-Fn"], {
      timeout: 2000,
    });
    const line = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("n/"));
    return line ? line.slice(1) : undefined;
  } catch {
    return undefined;
  }
}

/** Batched variant of `getProcessTty` — one `lsof -p pid1,pid2,...` call
 *  returns the controlling tty for every PID at once. Returns a Map keyed
 *  by PID; PIDs with no tty (or lsof errors) are simply absent. lsof's `-F`
 *  output is one field per line, with `p<pid>` markers preceding each
 *  process's records, so we walk the lines with a running `currentPid` and
 *  pair the next `n<path>` we see with it. */
export async function getProcessTtys(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", pids.join(","), "-d", "0", "-Fn"], {
      timeout: 2000,
    });
    let currentPid: number | undefined;
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("p")) {
        const parsed = Number.parseInt(line.slice(1), 10);
        currentPid = Number.isFinite(parsed) ? parsed : undefined;
      } else if (currentPid !== undefined && line.startsWith("n/")) {
        // Keep the first `n` field per pid (stdin's tty); ignore any extras.
        if (!result.has(currentPid)) result.set(currentPid, line.slice(1));
      }
    }
  } catch {
    // partial output may still be useful if returned; otherwise empty map.
  }
  return result;
}

/** Find the agent PID that runs inside the currently active tmux pane.
 *
 *  Two-tier match:
 *    1. pid-tree — `panePid` is the pane's shell PID; walk its descendants
 *       and find one matching `agentPids`. Works in most cases.
 *    2. tty fallback — when the pid-tree walk misses (e.g. macOS denies
 *       ps walks for some processes), compare the pane's controlling tty
 *       with each agent process's controlling tty. The agent and the
 *       pane's shell share a tty when they run in the same pane.
 *
 *  When `panePid` is provided, skips the tmux query (useful when the
 *  caller already resolved the active pane PID for cache-key purposes). */
export async function findActiveAgentPid(
  agentPids: number[],
  panePid?: number,
): Promise<number | undefined> {
  if (agentPids.length === 0) return undefined;
  try {
    const activePanePid = panePid ?? (await getActiveTmuxPanePid());
    if (!activePanePid) return undefined;

    // Tier 1: pid-tree
    const childMap = await getProcessTree();
    const treeMatch = agentPids.find((pid) => isPidInTree(activePanePid, pid, childMap));
    if (treeMatch !== undefined) return treeMatch;

    // Tier 2: tty fallback — one batched lsof for the pane shell + all
    // agent PIDs, instead of N+1 separate calls.
    const ttys = await getProcessTtys([activePanePid, ...agentPids]);
    const paneTty = ttys.get(activePanePid);
    if (!paneTty) return undefined;
    for (const agentPid of agentPids) {
      if (ttys.get(agentPid) === paneTty) return agentPid;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function resolveTmuxJumpTarget(
  agent: Pick<AgentSession, "pid" | "cwd">,
): Promise<TmuxJumpTarget | undefined> {
  return (await resolveAgentTmuxTargets([agent], true)).get(agent.pid);
}

/** Resolve all labels in one batch. Display defaults to proven process/TTY
 * ownership; jump preserves only an unambiguous cwd fallback. */
export async function resolveAgentTmuxTargets(
  agents: Array<Pick<AgentSession, "pid" | "cwd">>,
  allowCwdFallback = false,
): Promise<Map<number, TmuxJumpTarget>> {
  const targets = new Map<number, TmuxJumpTarget>();
  if (agents.length === 0) return targets;
  try {
    const [panes, tree] = await Promise.all([listTmuxPanes(), getProcessTree()]);
    if (panes.length === 0) return targets;
    for (const agent of agents) {
      const target = selectTmuxPaneForAgent(agent, panes, tree, new Map(), false);
      if (target) targets.set(agent.pid, target);
    }
    const unresolved = agents.filter((agent) => !targets.has(agent.pid));
    if (unresolved.length > 0) {
      const ttys = await getProcessTtys([
        ...new Set([...unresolved.map((a) => a.pid), ...panes.map((p) => p.panePid)]),
      ]);
      for (const agent of unresolved) {
        const target = selectTmuxPaneForAgent(agent, panes, tree, ttys, allowCwdFallback);
        if (target) targets.set(agent.pid, target);
      }
    }
  } catch {
    // Location is optional: keep the running CLI and fall back to PID labels.
  }
  return targets;
}

export async function captureTmuxPaneOutput(
  target: TmuxJumpTarget,
  lines = 30,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane",
      "-p",
      "-t",
      target.pane.paneId ?? target.pane.target,
      "-S",
      `-${lines}`,
    ]);
    return stdout;
  } catch {
    return undefined;
  }
}

export async function jumpToTmuxPane(target: TmuxJumpTarget): Promise<boolean> {
  const windowTarget = `${target.pane.sessionName}:${target.pane.windowIndex}`;

  try {
    if (process.env.TMUX) {
      await execFileAsync("tmux", ["switch-client", "-t", windowTarget]);
      await execFileAsync("tmux", ["select-window", "-t", windowTarget]);
      await execFileAsync("tmux", ["select-pane", "-t", target.pane.target]);
      return true;
    }

    await execFileAsync("tmux", ["select-window", "-t", windowTarget]);
    await execFileAsync("tmux", ["select-pane", "-t", target.pane.target]);
    return true;
  } catch {
    return false;
  }
}

const ANCHOR_PATH = join(tmpdir(), "marmonitor", "jump-anchors.json");

export async function jumpToAgent(
  agent: Pick<AgentSession, "pid" | "cwd">,
): Promise<TmuxJumpResult> {
  // Save current location as jump-back anchor before jumping
  if (process.env.TMUX) {
    const [tty, location] = await Promise.all([getClientTty(), getCurrentTmuxLocation()]);
    if (tty && location) {
      await saveJumpAnchorIfMissing(ANCHOR_PATH, tty, location).catch(() => {});
    }
  }

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

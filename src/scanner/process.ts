/**
 * Process utilities for the scanner.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MarmonitorConfig } from "../config/index.js";
import { profileAsync } from "../perf.js";
import type { RuntimeSource } from "../types.js";
import {
  PROCESS_CWD_TTL_MS,
  PROCESS_START_SHARED_TTL_MS,
  PROCESS_START_TTL_MS,
  processCwdCache,
  processStartCache,
} from "./cache.js";
import { readSharedCache, writeSharedCache } from "./shared-cache.js";

export const execFileAsync = promisify(execFile);

interface ProcessCwdOptions {
  cacheRoot?: string;
  nowMs?: number;
  execFile?: typeof execFileAsync;
}

interface ProcessStartOptions {
  cacheRoot?: string;
  nowMs?: number;
  execFile?: typeof execFileAsync;
  sharedKey?: string;
  sharedTtlMs?: number;
}

/** Get process cwd via lsof (fallback for non-Claude agents) */
export async function getProcessCwd(
  pid: number,
  options: ProcessCwdOptions = {},
): Promise<string | undefined> {
  const nowMs = options.nowMs ?? Date.now();
  const cached = processCwdCache.get(pid);
  if (cached && nowMs - cached.checkedAt < PROCESS_CWD_TTL_MS) {
    return cached.cwd;
  }

  const sharedCached = await readSharedCache<string | undefined>(
    "process-cwd",
    String(pid),
    PROCESS_CWD_TTL_MS,
    {
      cacheRoot: options.cacheRoot,
      nowMs,
    },
  );
  if (sharedCached) {
    processCwdCache.set(pid, {
      checkedAt: sharedCached.checkedAt,
      cwd: sharedCached.value,
    });
    return sharedCached.value;
  }

  const runExecFile = options.execFile ?? execFileAsync;
  try {
    const { stdout } = await profileAsync("process", "lsof", () =>
      runExecFile("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"], {
        encoding: "utf-8",
        timeout: 3000,
      }),
    );
    const match = stdout.split("\n").find((line) => line.startsWith("n/"));
    const cwd = match ? match.slice(1) : undefined;
    processCwdCache.set(pid, {
      checkedAt: nowMs,
      cwd,
    });
    await writeSharedCache("process-cwd", String(pid), cwd, {
      cacheRoot: options.cacheRoot,
      nowMs,
    });
    return cwd;
  } catch {
    processCwdCache.set(pid, {
      checkedAt: nowMs,
      cwd: undefined,
    });
    await writeSharedCache("process-cwd", String(pid), undefined, {
      cacheRoot: options.cacheRoot,
      nowMs,
    });
    return undefined;
  }
}

export async function getProcessStartTime(
  pid: number,
  options: ProcessStartOptions = {},
): Promise<number | undefined> {
  const nowMs = options.nowMs ?? Date.now();
  const sharedKey = options.sharedKey ?? String(pid);
  const sharedTtlMs = options.sharedTtlMs ?? PROCESS_START_SHARED_TTL_MS;
  const cached = processStartCache.get(pid);
  if (cached && nowMs - cached.checkedAt < PROCESS_START_TTL_MS) {
    return cached.startedAt;
  }

  if (sharedTtlMs > 0) {
    const sharedCached = await readSharedCache<number | undefined>(
      "process-start",
      sharedKey,
      sharedTtlMs,
      {
        cacheRoot: options.cacheRoot,
        nowMs,
      },
    );
    if (sharedCached) {
      processStartCache.set(pid, {
        checkedAt: sharedCached.checkedAt,
        startedAt: sharedCached.value,
      });
      return sharedCached.value;
    }
  }

  const runExecFile = options.execFile ?? execFileAsync;
  try {
    const { stdout } = await profileAsync("process", "ps_lstart", () =>
      runExecFile("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
      }),
    );
    const trimmed = stdout.trim();
    const startedAt = trimmed ? new Date(trimmed).getTime() / 1000 : undefined;
    processStartCache.set(pid, {
      checkedAt: nowMs,
      startedAt,
    });
    if (sharedTtlMs > 0) {
      await writeSharedCache("process-start", sharedKey, startedAt, {
        cacheRoot: options.cacheRoot,
        nowMs,
      });
    }
    return startedAt;
  } catch {
    processStartCache.set(pid, {
      checkedAt: nowMs,
      startedAt: undefined,
    });
    if (sharedTtlMs > 0) {
      await writeSharedCache("process-start", sharedKey, undefined, {
        cacheRoot: options.cacheRoot,
        nowMs,
      });
    }
    return undefined;
  }
}

export function detectRuntimeSource(agentName: string, cmd?: string): RuntimeSource | undefined {
  if (agentName === "Gemini") return "cli";
  if (agentName !== "Codex") return undefined;
  const normalized = (cmd ?? "").toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes(".vscode/extensions") || normalized.includes("app-server")) {
    return "vscode";
  }
  return "cli";
}

export function matchesProcessCommand(command: string, processName: string): boolean {
  const escaped = processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[/\\\\])${escaped}(?:\\s|$)`, "i").test(command);
}

/** Match a process against agent signatures using process name first, then cmd fallback. */
export function detectAgentFromProcessSignature(
  proc: { name: string; cmd?: string },
  config: MarmonitorConfig,
): string | null {
  const name = proc.name.toLowerCase();
  const command = (proc.cmd ?? "").toLowerCase();
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    for (const pname of agentConfig.processNames) {
      if (name === pname) return agentName;
      if (command && matchesProcessCommand(command, pname)) return agentName;
    }
  }
  return null;
}

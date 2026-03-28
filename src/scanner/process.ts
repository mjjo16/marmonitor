/**
 * Process utilities for the scanner.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MarmonitorConfig } from "../config/index.js";
import type { RuntimeSource } from "../types.js";
import {
  PROCESS_CWD_TTL_MS,
  PROCESS_START_TTL_MS,
  processCwdCache,
  processStartCache,
} from "./cache.js";

export const execFileAsync = promisify(execFile);

/** Get process cwd via lsof (fallback for non-Claude agents) */
export async function getProcessCwd(pid: number): Promise<string | undefined> {
  const cached = processCwdCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < PROCESS_CWD_TTL_MS) {
    return cached.cwd;
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-p", String(pid), "-Fn"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    const match = stdout.split("\n").find((line) => line.startsWith("n/"));
    const cwd = match ? match.slice(1) : undefined;
    processCwdCache.set(pid, {
      checkedAt: Date.now(),
      cwd,
    });
    return cwd;
  } catch {
    processCwdCache.set(pid, {
      checkedAt: Date.now(),
      cwd: undefined,
    });
    return undefined;
  }
}

export async function getProcessStartTime(pid: number): Promise<number | undefined> {
  const cached = processStartCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < PROCESS_START_TTL_MS) {
    return cached.startedAt;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
    });
    const trimmed = stdout.trim();
    const startedAt = trimmed ? new Date(trimmed).getTime() / 1000 : undefined;
    processStartCache.set(pid, {
      checkedAt: Date.now(),
      startedAt,
    });
    return startedAt;
  } catch {
    processStartCache.set(pid, {
      checkedAt: Date.now(),
      startedAt: undefined,
    });
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

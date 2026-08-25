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

/**
 * Environment for external commands whose output we parse.
 *
 * `ps -o lstart=` renders through LC_TIME, so a Korean or German locale emits
 * "2026년 8월 17일 월요일 16시 27분 49초" / "Mo. 17 Aug. 16:27:49 2026" — neither
 * of which `new Date()` can parse. Pinning the locale keeps the output in the
 * one format our parsers were written against.
 */
function parseableOutputEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C" };
}

/**
 * Parse a `ps -o lstart=` line into epoch seconds.
 *
 * Exported for tests: the locale that produced a given line cannot be recreated
 * on an arbitrary CI runner, so the parser is exercised with captured output
 * instead of a live `ps` call.
 */
export function parsePsLstart(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed).getTime();
  // A non-C locale (or any unexpected format) yields NaN here. Returning it
  // would poison every downstream comparison — NaN passes `>` thresholds and
  // silently disables mtime prefilters — and the value is cached for minutes.
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

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
      env: parseableOutputEnv(),
    });
    const startedAt = parsePsLstart(stdout);
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
  if (normalized.includes(".vscode/extensions")) {
    return "vscode";
  }
  return "cli";
}

export function matchesProcessCommand(command: string, processName: string): boolean {
  const escaped = processName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[/\\\\])${escaped}(?:\\s|$)`, "i").test(command);
}

/** Electron sub-process flags that indicate a desktop GUI helper, not a CLI agent. */
const ELECTRON_TYPE_RE = /--type=(utility|renderer|gpu-process|zygote|broker)/;
const CODEX_VSCODE_APP_SERVER_RE = /[/\\]codex\s+app-server(?:\s|$)/i;

/** Codex `app-server` mode is an IDE/Desktop embedded RPC backend, not an interactive CLI session. */
const CODEX_APP_SERVER_RE = /\bcodex\b[\s\S]*\bapp-server\b/i;

/**
 * `codex sandbox` runs one command inside the sandbox — the shape the ChatGPT
 * desktop app spawns. It owns no rollout of its own, so leaving it in the pool
 * only gave the cwd heuristic another process to misbind (#114).
 */
const CODEX_SANDBOX_RE = /[/\\]codex\s+sandbox(?:\s|$)/i;

/** Match a process against agent signatures using process name first, then cmd fallback. */
export function detectAgentFromProcessSignature(
  proc: { name: string; cmd?: string },
  config: MarmonitorConfig,
): string | null {
  // Skip Electron sub-processes (renderer, utility, gpu, zygote) to avoid
  // false-positive detection of desktop apps (e.g. Claude Desktop) as CLI agents.
  if (proc.cmd && ELECTRON_TYPE_RE.test(proc.cmd)) return null;
  // Skip `codex app-server` backends spawned by Codex Desktop or the VS Code
  // Codex extension — these are RPC backends, not interactive CLI sessions.
  if (proc.cmd && CODEX_APP_SERVER_RE.test(proc.cmd)) return null;
  if (proc.cmd && CODEX_SANDBOX_RE.test(proc.cmd)) return null;

  const name = proc.name.toLowerCase();
  const command = (proc.cmd ?? "").toLowerCase();
  if (command.includes(".vscode/extensions") && CODEX_VSCODE_APP_SERVER_RE.test(proc.cmd ?? "")) {
    return null;
  }
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    for (const pname of agentConfig.processNames) {
      if (name === pname) return agentName;
      if (command && matchesProcessCommand(command, pname)) return agentName;
    }
  }
  return null;
}

/**
 * Status determination and CLI stdout phase detection.
 */

import type { MarmonitorConfig } from "../config/index.js";
import { detectApprovalPromptPhase } from "../output/utils.js";
import { profileAsync } from "../perf.js";
import { captureTmuxPaneOutput, resolveTmuxJumpTarget } from "../tmux/index.js";
import type { AgentSession, SessionPhase, SessionStatus } from "../types.js";
import { RECENT_ACTIVITY_ACTIVE_SEC, stdoutHeuristicCache } from "./cache.js";
import { readSharedCache, writeSharedCache } from "./shared-cache.js";

interface StdoutPhaseDetectionOptions {
  cacheRoot?: string;
  nowMs?: number;
  resolveTmuxJumpTarget?: typeof resolveTmuxJumpTarget;
  captureTmuxPaneOutput?: typeof captureTmuxPaneOutput;
}

/** Determine agent activity status */
export function determineStatus(
  cpuPercent: number,
  elapsedSec: number | undefined,
  sessionMatched: boolean,
  phase: SessionPhase | undefined,
  config: MarmonitorConfig,
): SessionStatus {
  // Zombie: process exists but no matching session
  if (!sessionMatched) return "Unmatched";

  // Active: CPU above threshold
  if (cpuPercent > config.status.activeCpuThreshold) return "Active";

  // Permission/thinking override: these phases require user attention
  // regardless of how long the process has been running
  if (phase === "permission" || phase === "thinking") return "Idle";

  if (phase === "tool" && (elapsedSec === undefined || elapsedSec <= RECENT_ACTIVITY_ACTIVE_SEC)) {
    return "Active";
  }

  // Stalled: idle for longer than configured threshold
  const stalledSec = config.status.stalledAfterMin * 60;
  if (elapsedSec !== undefined && elapsedSec > stalledSec && cpuPercent < 0.1) {
    return "Stalled";
  }

  return "Idle";
}

export async function detectCliStdoutPhase(
  agent: Pick<AgentSession, "pid" | "cwd">,
  config: MarmonitorConfig,
  options: StdoutPhaseDetectionOptions = {},
): Promise<SessionPhase> {
  return await profileAsync("stdout_heuristic", "detectCliStdoutPhase", async () => {
    const nowMs = options.nowMs ?? Date.now();
    const cached = stdoutHeuristicCache.get(agent.pid);
    if (cached && nowMs - cached.checkedAt < config.performance.stdoutHeuristicTtlMs) {
      return cached.phase;
    }

    const sharedKey = `${agent.pid}:${agent.cwd}`;
    const sharedCached = await readSharedCache<SessionPhase>(
      "stdout-heuristic",
      sharedKey,
      config.performance.stdoutHeuristicTtlMs,
      {
        cacheRoot: options.cacheRoot,
        nowMs,
      },
    );
    if (sharedCached) {
      stdoutHeuristicCache.set(agent.pid, {
        checkedAt: sharedCached.checkedAt,
        phase: sharedCached.value,
      });
      return sharedCached.value;
    }

    const resolveTarget = options.resolveTmuxJumpTarget ?? resolveTmuxJumpTarget;
    const captureOutput = options.captureTmuxPaneOutput ?? captureTmuxPaneOutput;

    const target = await resolveTarget(agent);
    if (!target) {
      stdoutHeuristicCache.set(agent.pid, { checkedAt: nowMs, phase: undefined });
      await writeSharedCache("stdout-heuristic", sharedKey, undefined, {
        cacheRoot: options.cacheRoot,
        nowMs,
      });
      return undefined;
    }

    const output = await captureOutput(target, 30);
    const phase = output
      ? detectApprovalPromptPhase(
          output,
          config.status.stdoutHeuristic.approvalPatterns,
          config.status.stdoutHeuristic.clearPatterns,
        )
      : undefined;
    stdoutHeuristicCache.set(agent.pid, { checkedAt: nowMs, phase });
    await writeSharedCache("stdout-heuristic", sharedKey, phase, {
      cacheRoot: options.cacheRoot,
      nowMs,
    });
    return phase;
  });
}

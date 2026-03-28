/**
 * Status determination and CLI stdout phase detection.
 */

import type { MarmonitorConfig } from "../config/index.js";
import { detectApprovalPromptPhase } from "../output/utils.js";
import { captureTmuxPaneOutput, resolveTmuxJumpTarget } from "../tmux/index.js";
import type { AgentSession, SessionPhase, SessionStatus } from "../types.js";
import { RECENT_ACTIVITY_ACTIVE_SEC, stdoutHeuristicCache } from "./cache.js";

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
): Promise<SessionPhase> {
  const cached = stdoutHeuristicCache.get(agent.pid);
  if (cached && Date.now() - cached.checkedAt < config.performance.stdoutHeuristicTtlMs) {
    return cached.phase;
  }

  const target = await resolveTmuxJumpTarget(agent);
  if (!target) {
    stdoutHeuristicCache.set(agent.pid, { checkedAt: Date.now(), phase: undefined });
    return undefined;
  }

  const output = await captureTmuxPaneOutput(target, 30);
  const phase = output
    ? detectApprovalPromptPhase(
        output,
        config.status.stdoutHeuristic.approvalPatterns,
        config.status.stdoutHeuristic.clearPatterns,
      )
    : undefined;
  stdoutHeuristicCache.set(agent.pid, { checkedAt: Date.now(), phase });
  return phase;
}

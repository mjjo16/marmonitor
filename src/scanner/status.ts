/**
 * Status determination and CLI stdout phase detection.
 */

import type { MarmonitorConfig } from "../config/index.js";
import { detectApprovalPromptPhase } from "../output/utils.js";
import { captureTmuxPaneOutput, resolveTmuxJumpTarget } from "../tmux/index.js";
import type { AgentSession, SessionPhase, SessionStatus } from "../types.js";
import {
  RECENT_ACTIVITY_ACTIVE_SEC,
  STATUS_HYSTERESIS_SEC,
  stdoutHeuristicCache,
} from "./cache.js";

export function refreshLastActivityAt(
  lastActivityAt: number | undefined,
  cpuPercent: number,
  phase: SessionPhase | undefined,
  activeCpuThreshold: number,
  agentName: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): number | undefined {
  if (agentName !== "Codex") return lastActivityAt;
  if (
    cpuPercent > activeCpuThreshold ||
    phase === "permission" ||
    phase === "thinking" ||
    phase === "tool"
  ) {
    return Math.max(lastActivityAt ?? 0, nowSec);
  }
  return lastActivityAt;
}

/** Determine agent activity status */
export function determineStatus(
  cpuPercent: number,
  elapsedSec: number | undefined,
  sessionMatched: boolean,
  phase: SessionPhase | undefined,
  config: MarmonitorConfig,
  agentName?: string,
): SessionStatus {
  // Zombie: process exists but no matching session
  if (!sessionMatched) return "Unmatched";

  const stalledSec = config.status.stalledAfterMin * 60;

  // Active: CPU above threshold
  if (cpuPercent > config.status.activeCpuThreshold) return "Active";

  // Recent active phases stay active briefly even after CPU bursts end.
  if (
    (phase === "permission" || phase === "thinking" || phase === "tool") &&
    (elapsedSec === undefined || elapsedSec <= RECENT_ACTIVITY_ACTIVE_SEC)
  ) {
    return "Active";
  }

  // Codex often drops to ~0% CPU immediately after a burst.
  // Keep it active for a short recent-activity grace window even without a strong phase.
  if (
    agentName === "Codex" &&
    elapsedSec !== undefined &&
    elapsedSec <= Math.min(60, RECENT_ACTIVITY_ACTIVE_SEC)
  ) {
    return "Active";
  }

  // Codex quiet sessions often hold a live rollout while CPU falls to 0%.
  // Treat them as idle for a much longer window before escalating to stalled.
  if (agentName === "Codex" && elapsedSec !== undefined && cpuPercent < 0.1) {
    const codexStalledSec = Math.max(stalledSec, 24 * 60 * 60);
    if (elapsedSec > codexStalledSec) return "Stalled";
    return "Idle";
  }

  // Stalled: idle for longer than configured threshold
  if (elapsedSec !== undefined && elapsedSec > stalledSec && cpuPercent < 0.1) {
    return "Stalled";
  }

  return "Idle";
}

export function applyStatusHysteresis(
  nextStatus: SessionStatus,
  previousStatus: SessionStatus | undefined,
  elapsedSec: number | undefined,
  phase: SessionPhase | undefined,
  agentName: string | undefined,
): SessionStatus {
  if (!previousStatus || previousStatus === nextStatus) return nextStatus;
  if (nextStatus === "Unmatched" || nextStatus === "Dead") return nextStatus;
  if (previousStatus === "Unmatched" || previousStatus === "Dead") return nextStatus;

  const hasLivePhase = phase === "permission" || phase === "thinking" || phase === "tool";
  const hysteresisSec =
    agentName === "Codex" ? Math.max(STATUS_HYSTERESIS_SEC, 60) : STATUS_HYSTERESIS_SEC;

  if (previousStatus === "Active" && (nextStatus === "Idle" || nextStatus === "Stalled")) {
    if (elapsedSec === undefined || elapsedSec <= hysteresisSec || hasLivePhase) {
      return "Active";
    }
  }

  if (previousStatus === "Idle" && nextStatus === "Stalled") {
    if (elapsedSec === undefined || elapsedSec <= hysteresisSec * 2 || hasLivePhase) {
      return "Idle";
    }
  }

  return nextStatus;
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

/**
 * Status determination and CLI stdout phase detection.
 */

import type { MarmonitorConfig } from "../config/index.js";
import { detectApprovalPromptPhase } from "../output/utils.js";
import { captureTmuxPaneOutput, resolveTmuxJumpTarget } from "../tmux/index.js";
import type { AgentSession, SessionPhase, SessionStatus } from "../types.js";
import {
  CODEX_INFERRED_BUSY_TTL_SEC,
  RECENT_ACTIVITY_ACTIVE_SEC,
  STATUS_HYSTERESIS_SEC,
  stdoutHeuristicCache,
} from "./cache.js";

/**
 * When a Codex process looks busy right now, independent of what its session
 * files say.
 *
 * Codex drops to ~0% CPU the instant a burst ends and its rollout file lags,
 * so #090 introduced this inference to stop `last activity` from snapping back
 * to the old mtime mid-turn. It is an inference, not an observation: it must be
 * kept apart from observed activity and given a lifetime, which is what #113
 * was about — the stamp used to be merged into `lastActivityAt` and persisted,
 * so one CPU blip made a long-dead session look recent forever.
 */
export function resolveCodexInferredBusyAt(
  cpuPercent: number,
  phase: SessionPhase | undefined,
  activeCpuThreshold: number,
  agentName: string | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): number | undefined {
  if (agentName !== "Codex") return undefined;
  if (
    cpuPercent > activeCpuThreshold ||
    phase === "permission" ||
    phase === "thinking" ||
    phase === "tool"
  ) {
    return nowSec;
  }
  return undefined;
}

/**
 * Whether a busy inference may still stand in for observed activity.
 *
 * A process doing real work keeps re-stamping well inside this window, so a
 * stamp older than the TTL means it has been quiet since — and the reported
 * time must fall back to what the session files actually show.
 */
export function isInferredBusyFresh(
  inferredBusyAt: number | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  ttlSec = CODEX_INFERRED_BUSY_TTL_SEC,
): boolean {
  return inferredBusyAt !== undefined && nowSec - inferredBusyAt <= ttlSec;
}

/**
 * Activity time to report: observed activity, or a still-fresh inference when
 * that is more recent. An expired inference is dropped so the reported time
 * falls back to what the session files actually show.
 */
export function resolveEffectiveActivityAt(
  observedActivityAt: number | undefined,
  inferredBusyAt: number | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  ttlSec = CODEX_INFERRED_BUSY_TTL_SEC,
): number | undefined {
  const usableInference = isInferredBusyFresh(inferredBusyAt, nowSec, ttlSec)
    ? inferredBusyAt
    : undefined;
  return Math.max(observedActivityAt ?? 0, usableInference ?? 0) || undefined;
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

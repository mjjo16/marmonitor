/**
 * Session activity tier classification.
 * Determines enrichment frequency based on how recently a session was active.
 */

export type SessionTier = "hot" | "warm" | "cold";

const HOT_THRESHOLD_SEC = 120; // 2 minutes
const WARM_THRESHOLD_SEC = 600; // 10 minutes
const CPU_HOT_THRESHOLD = 1.0; // CPU% above this = always hot

const HOT_PHASES = new Set(["permission", "thinking", "tool"]);

export function classifySessionTier(
  lastActivityAt: number | undefined,
  nowSec: number,
  cpuPercent = 0,
  phase?: string,
): SessionTier {
  if (cpuPercent >= CPU_HOT_THRESHOLD) return "hot";
  if (phase && HOT_PHASES.has(phase)) return "hot";
  if (lastActivityAt === undefined) return "cold";
  const elapsed = nowSec - lastActivityAt;
  if (elapsed <= HOT_THRESHOLD_SEC) return "hot";
  if (elapsed <= WARM_THRESHOLD_SEC) return "warm";
  return "cold";
}

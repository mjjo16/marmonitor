/** Token threshold alert trigger */

import type { AgentSession } from "../types.js";
import type { AlertStore } from "./store.js";
import type { Alert } from "./types.js";

/** Known model context window sizes (tokens) */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-opus-4": 200_000,
  "claude-sonnet-4": 200_000,
  "claude-haiku-4": 200_000,
  "claude-3-5-sonnet": 200_000,
  "claude-3-5-haiku": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-sonnet": 200_000,
  "claude-3-haiku": 200_000,
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

function contextLimit(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.toLowerCase().includes(key)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

export interface TokenAlertThresholds {
  warnAt: number; // e.g. 0.70
  critAt: number; // e.g. 0.85
}

export const DEFAULT_TOKEN_THRESHOLDS: TokenAlertThresholds = {
  warnAt: 0.7,
  critAt: 0.85,
};

/**
 * Check an agent's token usage against thresholds.
 * Creates an alert in store if threshold exceeded (deduped).
 * Returns the created alert or undefined if no threshold crossed or deduped.
 */
export function checkTokenAlert(
  store: AlertStore,
  agent: AgentSession,
  thresholds: TokenAlertThresholds = DEFAULT_TOKEN_THRESHOLDS,
): Alert | undefined {
  const usage = agent.tokenUsage;
  if (!usage) return undefined;

  // lastInputTokens = most recent API call's input_tokens = actual current context size.
  // Fall back to cumulative inputTokens only if lastInputTokens is unavailable.
  const used = usage.lastInputTokens ?? usage.inputTokens;
  const limit = contextLimit(agent.model);
  const ratio = used / limit;

  if (ratio >= thresholds.critAt) {
    return store.create({
      type: "context_critical",
      severity: "critical",
      agentPid: agent.pid,
      sessionId: agent.sessionId,
      cwd: agent.cwd,
      message: `Context ${Math.round(ratio * 100)}% full — /clear or new session recommended`,
      detail: `used=${used.toLocaleString()} limit=${limit.toLocaleString()} model=${agent.model ?? "unknown"}`,
    });
  }

  if (ratio >= thresholds.warnAt) {
    return store.create({
      type: "context_warn",
      severity: "warn",
      agentPid: agent.pid,
      sessionId: agent.sessionId,
      cwd: agent.cwd,
      message: `Context ${Math.round(ratio * 100)}% full`,
      detail: `used=${used.toLocaleString()} limit=${limit.toLocaleString()} model=${agent.model ?? "unknown"}`,
    });
  }

  return undefined;
}

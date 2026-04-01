import type { AgentSession } from "../types.js";

export type StatusClickAction = { kind: "jump"; pid: number } | { kind: "jump-back" };

export function parseStatusClickToken(token?: string): StatusClickAction | undefined {
  if (!token) return undefined;
  const trimmed = token.trim();
  if (trimmed === "jump-back") return { kind: "jump-back" };

  const pidMatch = /^pid:(\d+)$/.exec(trimmed);
  if (!pidMatch) return undefined;

  const pid = Number.parseInt(pidMatch[1] ?? "", 10);
  if (!Number.isFinite(pid)) return undefined;
  return { kind: "jump", pid };
}

export function findClickedAgent(
  sessions: AgentSession[],
  action: StatusClickAction,
): AgentSession | undefined {
  if (action.kind !== "jump") return undefined;
  return sessions.find((session) => session.pid === action.pid);
}

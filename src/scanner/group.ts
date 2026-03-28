/**
 * Process tree grouping and worker state propagation.
 */

import type { AgentSession } from "../types.js";

export function propagateWorkerStateToParent(
  parent: AgentSession,
  child: Pick<
    AgentSession,
    | "status"
    | "phase"
    | "lastActivityAt"
    | "lastResponseAt"
    | "startedAt"
    | "cpuPercent"
    | "memoryMb"
  >,
): AgentSession {
  if (child.status !== "Active") return parent;

  const inheritedPhase =
    child.phase && child.phase !== "done"
      ? child.phase
      : parent.phase === "permission" || parent.phase === "done" || parent.phase === undefined
        ? "tool"
        : parent.phase;

  return {
    ...parent,
    status: "Active",
    phase: inheritedPhase,
    cpuPercent: parent.cpuPercent + (("cpuPercent" in child && child.cpuPercent) || 0),
    memoryMb: parent.memoryMb + (("memoryMb" in child && child.memoryMb) || 0),
    startedAt:
      parent.startedAt && child.startedAt
        ? Math.min(parent.startedAt, child.startedAt)
        : (parent.startedAt ?? child.startedAt),
    lastActivityAt: Math.max(
      parent.lastActivityAt ?? 0,
      child.lastActivityAt ?? 0,
      child.lastResponseAt ?? 0,
      child.startedAt ?? 0,
    ),
    lastResponseAt: Math.max(parent.lastResponseAt ?? 0, child.lastResponseAt ?? 0) || undefined,
  };
}

/** Group child agent processes under their parent */
export function groupByParent(sessions: AgentSession[]): AgentSession[] {
  const pidSet = new Set(sessions.map((s) => s.pid));
  const childPids = new Set<number>();

  for (const session of sessions) {
    if (session.ppid && pidSet.has(session.ppid)) {
      const parent = sessions.find(
        (s) => s.pid === session.ppid && s.agentName === session.agentName,
      );
      if (parent) {
        if (!parent.workers) parent.workers = [];
        parent.workers.push({
          pid: session.pid,
          cpuPercent: session.cpuPercent,
          memoryMb: session.memoryMb,
          status: session.status,
        });
        const propagated = propagateWorkerStateToParent(parent, session);
        parent.cpuPercent = propagated.cpuPercent;
        parent.memoryMb = propagated.memoryMb;
        parent.status = propagated.status;
        parent.phase = propagated.phase;
        parent.startedAt = propagated.startedAt;
        parent.lastActivityAt = propagated.lastActivityAt;
        parent.lastResponseAt = propagated.lastResponseAt;
        childPids.add(session.pid);
      }
    }
  }

  return sessions.filter((s) => !childPids.has(s.pid));
}

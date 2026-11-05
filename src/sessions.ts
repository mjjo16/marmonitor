import type { AgentSession } from "./types.js";

/** A CLI's existence is independent of whether its metadata has been bound.
 * Unmatched CLIs still count as running; historical dead sessions never do. */
export function partitionSessions(agents: AgentSession[]): {
  running: AgentSession[];
  matched: AgentSession[];
  unmatched: AgentSession[];
  dead: AgentSession[];
} {
  const running = agents.filter((agent) => agent.status !== "Dead");
  return {
    running,
    matched: running.filter((agent) => agent.status !== "Unmatched"),
    unmatched: running.filter((agent) => agent.status === "Unmatched"),
    dead: agents.filter((agent) => agent.status === "Dead"),
  };
}

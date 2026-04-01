/**
 * Session registry — tracks session lifecycle across PID/JSONL changes.
 * Maps sessionId → session history with PID changes and token accumulation.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSession } from "../types.js";

export interface SessionRegistryRecord {
  sessionId: string;
  agent: string;
  cwd: string;
  history: Array<{
    pid: number;
    jsonlPath?: string;
    startedAt: number;
    endedAt?: number;
  }>;
  totalTokens: {
    input: number;
    output: number;
    cache: number;
  };
  lastActivityAt?: number;
  model?: string;
}

export function updateRegistry(
  registry: Map<string, SessionRegistryRecord>,
  agents: Partial<AgentSession>[],
): void {
  for (const agent of agents) {
    if (!agent.sessionId) continue;

    const existing = registry.get(agent.sessionId);
    if (existing) {
      // Check if PID changed (resume)
      const lastEntry = existing.history[existing.history.length - 1];
      if (lastEntry && lastEntry.pid !== agent.pid) {
        // Mark previous as ended
        if (!lastEntry.endedAt) lastEntry.endedAt = Math.floor(Date.now() / 1000);
        // Add new PID to history
        existing.history.push({
          pid: agent.pid ?? 0,
          startedAt: agent.startedAt ?? Math.floor(Date.now() / 1000),
        });
      }

      // Update token totals
      if (agent.tokenUsage) {
        existing.totalTokens.input = agent.tokenUsage.inputTokens ?? 0;
        existing.totalTokens.output = agent.tokenUsage.outputTokens ?? 0;
        existing.totalTokens.cache = agent.tokenUsage.cacheReadTokens ?? 0;
      }
      if (agent.lastActivityAt) existing.lastActivityAt = agent.lastActivityAt;
      if (agent.model) existing.model = agent.model;
      if (agent.cwd) existing.cwd = agent.cwd;
    } else {
      // New session
      registry.set(agent.sessionId, {
        sessionId: agent.sessionId,
        agent: agent.agentName ?? "unknown",
        cwd: agent.cwd ?? "unknown",
        history: [
          {
            pid: agent.pid ?? 0,
            startedAt: agent.startedAt ?? Math.floor(Date.now() / 1000),
          },
        ],
        totalTokens: {
          input: agent.tokenUsage?.inputTokens ?? 0,
          output: agent.tokenUsage?.outputTokens ?? 0,
          cache: agent.tokenUsage?.cacheReadTokens ?? 0,
        },
        lastActivityAt: agent.lastActivityAt,
        model: agent.model,
      });
    }
  }
}

/**
 * Remove sessions whose lastActivityAt is older than maxAgeDays.
 * Returns the number of pruned entries.
 */
export function pruneRegistry(
  registry: Map<string, SessionRegistryRecord>,
  maxAgeDays: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  let pruned = 0;
  for (const [key, record] of registry) {
    if (record.lastActivityAt !== undefined && record.lastActivityAt < cutoff) {
      registry.delete(key);
      pruned++;
    }
  }
  return pruned;
}

export async function saveRegistryToFile(
  filePath: string,
  registry: Map<string, SessionRegistryRecord>,
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const data = Object.fromEntries(registry.entries());
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // registry save failures must never crash
  }
}

export async function loadRegistryFromFile(
  filePath: string,
  registry: Map<string, SessionRegistryRecord>,
): Promise<void> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        registry.set(key, value as SessionRegistryRecord);
      }
    }
  } catch {
    // missing or malformed file — start with empty registry
  }
}

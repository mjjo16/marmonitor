/**
 * Session registry — tracks session lifecycle across PID/JSONL changes.
 * Maps sessionId → session history with PID changes and token accumulation.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSession } from "../types.js";
import { CODEX_INFERRED_BUSY_TTL_SEC } from "./cache.js";

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

export interface SessionRegistryUpdate extends Partial<AgentSession> {
  jsonlPath?: string;
}

/**
 * The activity time safe to write to disk: the observed one when the caller
 * tracks it at all, otherwise whatever it reported. Callers that split the two
 * always set `observedActivityAt`, even when it is undefined, so its presence —
 * not its value — is what says "this caller separates observation from
 * inference" (#113).
 */
function resolveObservedForPersist(agent: SessionRegistryUpdate): number | undefined {
  return "observedActivityAt" in agent ? agent.observedActivityAt : agent.lastActivityAt;
}

export function updateRegistry(
  registry: Map<string, SessionRegistryRecord>,
  agents: SessionRegistryUpdate[],
): void {
  for (const agent of agents) {
    if (!agent.sessionId) continue;

    const existing = registry.get(agent.sessionId);
    if (existing) {
      const lastEntry = existing.history[existing.history.length - 1];
      const nextPid = agent.pid ?? 0;
      const nextStartedAt = agent.startedAt ?? Math.floor(Date.now() / 1000);
      const nextJsonlPath = agent.jsonlPath;
      const pidChanged = Boolean(lastEntry && lastEntry.pid !== nextPid);
      const jsonlChanged = Boolean(
        lastEntry && nextJsonlPath && lastEntry.jsonlPath && lastEntry.jsonlPath !== nextJsonlPath,
      );

      if (lastEntry && (pidChanged || jsonlChanged)) {
        if (!lastEntry.endedAt) lastEntry.endedAt = Math.floor(Date.now() / 1000);
        existing.history.push({
          pid: nextPid,
          jsonlPath: nextJsonlPath,
          startedAt: nextStartedAt,
        });
      } else if (lastEntry && nextJsonlPath && !lastEntry.jsonlPath) {
        lastEntry.jsonlPath = nextJsonlPath;
      }

      if (agent.tokenUsage) {
        existing.totalTokens.input = agent.tokenUsage.inputTokens ?? 0;
        existing.totalTokens.output = agent.tokenUsage.outputTokens ?? 0;
        existing.totalTokens.cache = agent.tokenUsage.cacheReadTokens ?? 0;
      }
      // #113: persist observed activity only. lastActivityAt may carry a
      // fresh CPU/phase inference, and this Math.max is monotonic with no
      // expiry — one inferred stamp on disk would outlive the session forever.
      // The fallback keys on the field being absent, not on it being unset: a
      // session with an inference but no observation reports the field as
      // undefined, and `??` would have written the inference instead.
      const observedAt = resolveObservedForPersist(agent);
      if (observedAt) {
        existing.lastActivityAt = Math.max(existing.lastActivityAt ?? 0, observedAt);
      }
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
            jsonlPath: agent.jsonlPath,
            startedAt: agent.startedAt ?? Math.floor(Date.now() / 1000),
          },
        ],
        totalTokens: {
          input: agent.tokenUsage?.inputTokens ?? 0,
          output: agent.tokenUsage?.outputTokens ?? 0,
          cache: agent.tokenUsage?.cacheReadTokens ?? 0,
        },
        lastActivityAt: resolveObservedForPersist(agent),
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

/**
 * Newest `jsonlPath` recorded for a session, ignoring path-less history entries.
 */
function findLatestJsonlPath(record: SessionRegistryRecord): string | undefined {
  const history = record.history;
  if (!history) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const jsonlPath = history[i]?.jsonlPath;
    if (jsonlPath) return jsonlPath;
  }
  return undefined;
}

/** Slack allowed before a record counts as drifted from its file. */
const CLAMP_TOLERANCE_SEC = CODEX_INFERRED_BUSY_TTL_SEC;

/**
 * Repair activity times that exceed what the session files can justify (#113).
 *
 * A record's `lastActivityAt` can never legitimately be newer than the mtime of
 * the jsonl it was derived from: the file is written when the event happens, so
 * the timestamp inside it is always at or before the write. Anything later came
 * from an inference that used to be persisted without an expiry, which left
 * long-quiet sessions reporting "recent" indefinitely — for ten days in the
 * case that surfaced this.
 *
 * Two things keep this from firing on legitimate drift. Times are compared
 * against the mtime rounded *up*, because stored stamps are fractional
 * (`mtimeMs / 1000`) and a floor comparison would clamp nearly every record by
 * under a second on every load. And a tolerance is allowed on top, because a
 * Codex time can come from the SQLite `updated_at` that `mergeCodexIndexedSessions`
 * maxes with the rollout mtime, so it may legitimately lead the file by a little.
 * The drift this repairs is hours to days, so the tolerance costs nothing.
 *
 * Records whose file is gone are left alone; there is nothing to check against.
 */
export async function clampRegistryActivityToObserved(
  registry: Map<string, SessionRegistryRecord>,
): Promise<number> {
  let repaired = 0;
  for (const record of registry.values()) {
    if (record.lastActivityAt === undefined) continue;
    // Walk back to the newest entry that actually carries a path. Only the
    // heavy-scan writer records one, so the final entry is routinely a
    // path-less light-scan append — anchoring on `at(-1)` alone skipped
    // exactly the long-lived records that drift furthest from their files.
    const jsonlPath = findLatestJsonlPath(record);
    if (!jsonlPath) continue;
    try {
      const fileStat = await stat(jsonlPath);
      const observedAt = Math.ceil(fileStat.mtimeMs / 1000);
      if (record.lastActivityAt > observedAt + CLAMP_TOLERANCE_SEC) {
        record.lastActivityAt = observedAt;
        repaired++;
      }
    } catch {
      // file moved or removed — nothing to validate against
    }
  }
  return repaired;
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
      await clampRegistryActivityToObserved(registry);
    }
  } catch {
    // missing or malformed file — start with empty registry
  }
}

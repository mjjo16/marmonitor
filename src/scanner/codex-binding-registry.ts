/**
 * Codex binding registry — persists PID/process bindings to Codex thread/jsonl.
 * 1차는 schema + load/save + prune만 제공한다.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexSessionMeta } from "./cache.js";

export interface CodexBindingRecord {
  pid: number;
  processStartedAt?: number;
  cwd: string;
  threadId: string;
  rolloutPath: string;
  lastVerifiedAt: number;
  confidence: "high" | "medium" | "low";
  unstableCount: number;
  deadAt?: number;
}

export type CodexBindingRegistry = Map<string, CodexBindingRecord>;

export function buildCodexBindingKey(pid: number, processStartedAt?: number): string {
  return `${pid}:${processStartedAt ?? 0}`;
}

export function selectCodexBindingSession(
  registry: CodexBindingRegistry,
  pid: number,
  processStartedAt: number | undefined,
  cwd: string,
  sessions: CodexSessionMeta[],
): CodexSessionMeta | undefined {
  const binding = registry.get(buildCodexBindingKey(pid, processStartedAt));
  if (!binding || binding.deadAt !== undefined) return undefined;
  if (binding.cwd !== cwd) return undefined;

  const matched = sessions.find(
    (session) =>
      session.id === binding.threadId &&
      session.filePath === binding.rolloutPath &&
      session.cwd === cwd,
  );
  return matched;
}

export function upsertCodexBindingRecord(
  registry: CodexBindingRegistry,
  params: {
    pid: number;
    processStartedAt?: number;
    cwd: string;
    matched: CodexSessionMeta;
    confidence?: CodexBindingRecord["confidence"];
  },
): void {
  const { pid, processStartedAt, cwd, matched, confidence = "high" } = params;
  const key = buildCodexBindingKey(pid, processStartedAt);
  const previous = registry.get(key);
  const now = Math.floor(Date.now() / 1000);
  const isChanged =
    previous !== undefined &&
    (previous.threadId !== matched.id || previous.rolloutPath !== matched.filePath);

  registry.set(key, {
    pid,
    processStartedAt,
    cwd,
    threadId: matched.id,
    rolloutPath: matched.filePath,
    lastVerifiedAt: now,
    confidence,
    unstableCount: isChanged ? (previous?.unstableCount ?? 0) + 1 : (previous?.unstableCount ?? 0),
    deadAt: undefined,
  });
}

export function markMissingCodexBindingsDead(
  registry: CodexBindingRegistry,
  aliveKeys: Set<string>,
): number {
  const now = Math.floor(Date.now() / 1000);
  let updated = 0;
  for (const [key, record] of registry) {
    if (aliveKeys.has(key)) continue;
    if (record.deadAt === undefined) {
      registry.set(key, { ...record, deadAt: now });
      updated++;
    }
  }
  return updated;
}

export function pruneCodexBindingRegistry(
  registry: CodexBindingRegistry,
  maxAgeDays: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  let pruned = 0;
  for (const [key, record] of registry) {
    if (record.deadAt !== undefined && record.deadAt < cutoff) {
      registry.delete(key);
      pruned++;
    }
  }
  return pruned;
}

export async function saveCodexBindingRegistryToFile(
  filePath: string,
  registry: CodexBindingRegistry,
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const data = Object.fromEntries(registry.entries());
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // registry save failures must never crash the daemon
  }
}

export async function loadCodexBindingRegistryFromFile(
  filePath: string,
  registry: CodexBindingRegistry,
): Promise<void> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      for (const [key, value] of Object.entries(data)) {
        registry.set(key, value as CodexBindingRecord);
      }
    }
  } catch {
    // missing or malformed file — start with empty registry
  }
}

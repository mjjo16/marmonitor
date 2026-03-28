/**
 * Claude Code session parsing, token extraction, and phase detection.
 */

import { existsSync } from "node:fs";
import { realpath as fsRealpath, open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MarmonitorConfig } from "../config/index.js";
import { resolveRuntimeDataPaths } from "../config/index.js";
import {
  advanceJsonlCursor,
  resolvePhaseFromHistory,
  resolvePhaseWithDecay,
  resolveSessionRegistryPath,
  selectRecentSessionFile,
  updatePhaseHistory,
  upsertSessionRegistryEntry,
} from "../output/utils.js";
import type { AgentSession, SessionPhase, TokenUsage } from "../types.js";
import {
  CLAUDE_PHASE_RECENT_LINES,
  CLAUDE_SESSION_AMBIGUITY_GAP_SEC,
  CLAUDE_SESSION_MTIME_MATCH_SEC,
  HOME,
  claudePhaseCache,
  claudeProjectDirCache,
  claudeSessionRegistry,
  claudeTokenCache,
} from "./cache.js";
import type { PhaseResult } from "./cache.js";

export function getClaudeProjectRoots(config?: MarmonitorConfig): string[] {
  return config
    ? resolveRuntimeDataPaths(config).claudeProjects
    : [join(HOME, ".claude", "projects")];
}

export function getClaudeSessionRoots(config?: MarmonitorConfig): string[] {
  return config
    ? resolveRuntimeDataPaths(config).claudeSessions
    : [join(HOME, ".claude", "sessions")];
}

/**
 * Find the Claude projects/ subdirectory matching a given cwd.
 * Strategy: (1) realpath + encode, (2) fallback scan by sessionId.
 */
export async function findClaudeProjectDir(
  cwd: string,
  sessionId?: string,
  config?: MarmonitorConfig,
): Promise<string | undefined> {
  const projectRoots = getClaudeProjectRoots(config);
  if (!projectRoots.some((projectsDir) => existsSync(projectsDir))) return undefined;
  const cacheKey = `${cwd}::${sessionId ?? ""}`;
  const cached = claudeProjectDirCache.get(cacheKey);
  if (cached && projectRoots.some((projectsDir) => existsSync(join(projectsDir, cached)))) {
    return cached;
  }

  // Claude Code encodes cwd by replacing both "/" and "." with "-"
  const encodeCwd = (p: string) => p.replace(/[/.]/g, "-");

  // 1st: realpath → encode → direct check
  try {
    const canonical = await fsRealpath(cwd).catch(() => cwd);
    const encoded = encodeCwd(canonical);
    for (const projectsDir of projectRoots) {
      if (existsSync(join(projectsDir, encoded))) {
        claudeProjectDirCache.set(cacheKey, encoded);
        return encoded;
      }
    }
  } catch {
    // continue to fallback
  }

  // 2nd: raw cwd encode (without realpath)
  const rawEncoded = encodeCwd(cwd);
  for (const projectsDir of projectRoots) {
    if (existsSync(join(projectsDir, rawEncoded))) {
      claudeProjectDirCache.set(cacheKey, rawEncoded);
      return rawEncoded;
    }
  }

  // 3rd: fallback scan — find dir containing sessionId.jsonl
  if (sessionId) {
    const registeredPath = resolveSessionRegistryPath(claudeSessionRegistry, sessionId);
    if (registeredPath && existsSync(registeredPath)) {
      const parts = registeredPath.split("/");
      const dir = parts.at(-2);
      if (dir) {
        claudeProjectDirCache.set(cacheKey, dir);
        return dir;
      }
    }

    try {
      for (const projectsDir of projectRoots) {
        if (!existsSync(projectsDir)) continue;
        const dirs = await readdir(projectsDir);
        for (const dir of dirs) {
          const sessionFile = join(projectsDir, dir, `${sessionId}.jsonl`);
          if (existsSync(sessionFile)) {
            upsertSessionRegistryEntry(claudeSessionRegistry, {
              filePath: sessionFile,
              sessionId,
              cwd,
              firstSeenOffset: 0,
              source: "claude",
            });
            claudeProjectDirCache.set(cacheKey, dir);
            return dir;
          }
        }
      }
    } catch {
      // scan failed
    }
  }

  return undefined;
}

export async function resolveClaudeSessionFile(
  sessionId: string,
  cwd: string,
  startedAt?: number,
  config?: MarmonitorConfig,
): Promise<string | undefined> {
  const registeredPath = resolveSessionRegistryPath(claudeSessionRegistry, sessionId);
  if (registeredPath && existsSync(registeredPath)) return registeredPath;

  const projectDirName = await findClaudeProjectDir(cwd, sessionId, config);
  if (!projectDirName) return undefined;
  const projectRoots = getClaudeProjectRoots(config);

  for (const projectsDir of projectRoots) {
    const directPath = join(projectsDir, projectDirName, `${sessionId}.jsonl`);
    if (existsSync(directPath)) {
      upsertSessionRegistryEntry(claudeSessionRegistry, {
        filePath: directPath,
        sessionId,
        cwd,
        firstSeenOffset: 0,
        startedAt,
        source: "claude",
      });
      return directPath;
    }
  }

  if (!startedAt) return undefined;

  try {
    const candidates: Array<{ path: string; deltaSec: number; mtimeMs: number }> = [];

    for (const projectsDir of projectRoots) {
      const projectDir = join(projectsDir, projectDirName);
      if (!existsSync(projectDir)) continue;
      const files = await readdir(projectDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const candidatePath = join(projectDir, file);
        try {
          const fileStat = await stat(candidatePath);
          candidates.push({
            path: candidatePath,
            deltaSec: Math.abs(fileStat.mtimeMs / 1000 - startedAt),
            mtimeMs: fileStat.mtimeMs,
          });
        } catch {
          // skip candidate
        }
      }
    }

    candidates.sort((a, b) => a.deltaSec - b.deltaSec);
    const best = candidates[0];
    const second = candidates[1];
    if (!best || best.deltaSec > CLAUDE_SESSION_MTIME_MATCH_SEC) {
      const fallbackPath = selectRecentSessionFile(candidates);
      if (!fallbackPath) return undefined;
      upsertSessionRegistryEntry(claudeSessionRegistry, {
        filePath: fallbackPath,
        sessionId,
        cwd,
        firstSeenOffset: 0,
        startedAt,
        source: "claude",
      });
      return fallbackPath;
    }
    if (second && second.deltaSec - best.deltaSec < CLAUDE_SESSION_AMBIGUITY_GAP_SEC) {
      const fallbackPath = selectRecentSessionFile(candidates);
      if (!fallbackPath) return undefined;
      upsertSessionRegistryEntry(claudeSessionRegistry, {
        filePath: fallbackPath,
        sessionId,
        cwd,
        firstSeenOffset: 0,
        startedAt,
        source: "claude",
      });
      return fallbackPath;
    }
    upsertSessionRegistryEntry(claudeSessionRegistry, {
      filePath: best.path,
      sessionId,
      cwd,
      firstSeenOffset: 0,
      startedAt,
      source: "claude",
    });
    return best.path;
  } catch {
    return undefined;
  }
}

/** Parse Claude session JSONL for token usage (streaming, stops early for large files) */
export async function parseClaudeTokens(
  sessionId: string,
  cwd: string,
  startedAt?: number,
  config?: MarmonitorConfig,
): Promise<{ tokenUsage?: TokenUsage; model?: string }> {
  const sessionFile = await resolveClaudeSessionFile(sessionId, cwd, startedAt, config);
  if (!sessionFile || !existsSync(sessionFile)) return {};

  try {
    const fileStat = await stat(sessionFile);
    const cached = claudeTokenCache.get(sessionFile);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.result;
    }

    let inputTokens = cached?.result.tokenUsage?.inputTokens ?? 0;
    let outputTokens = cached?.result.tokenUsage?.outputTokens ?? 0;
    let cacheCreationTokens = cached?.result.tokenUsage?.cacheCreationTokens ?? 0;
    let cacheReadTokens = cached?.result.tokenUsage?.cacheReadTokens ?? 0;
    let model: string | undefined = cached?.result.model;

    let raw: string;
    if (cached && fileStat.size > cached.size) {
      const appendSize = fileStat.size - cached.size;
      const fd = await open(sessionFile, "r");
      const buf = Buffer.alloc(appendSize);
      await fd.read(buf, 0, appendSize, cached.size);
      await fd.close();
      raw = buf.toString("utf-8");
    } else {
      raw = await readFile(sessionFile, "utf-8");
      inputTokens = 0;
      outputTokens = 0;
      cacheCreationTokens = 0;
      cacheReadTokens = 0;
      model = undefined;
    }

    const lines = raw.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const usage = entry?.message?.usage;
        if (!usage) continue;

        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;

        if (entry?.message?.model) model = entry.message.model;
      } catch {
        // skip malformed lines
      }
    }

    const result = {
      tokenUsage:
        inputTokens === 0 && outputTokens === 0
          ? undefined
          : {
              inputTokens,
              outputTokens,
              cacheCreationTokens,
              cacheReadTokens,
              totalTokens: inputTokens + outputTokens,
            },
      model,
    };
    claudeTokenCache.set(sessionFile, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      result,
    });
    return result;
  } catch {
    return {};
  }
}

/**
 * Detect current Claude session phase by reading the last few lines of JSONL.
 */
export async function detectClaudePhase(
  sessionId: string,
  cwd: string,
  startedAt?: number,
  config?: MarmonitorConfig,
): Promise<PhaseResult> {
  const sessionFile = await resolveClaudeSessionFile(sessionId, cwd, startedAt, config);
  if (!sessionFile || !existsSync(sessionFile)) return {};

  try {
    const fileStat = await stat(sessionFile);
    const cached = claudePhaseCache.get(sessionFile);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return {
        ...cached.result,
        phase: config
          ? resolvePhaseWithDecay(
              cached.result.phase,
              cached.result.phase,
              cached.phaseDetectedAtMs,
              config.status.phaseDecay,
            )
          : cached.result.phase,
      };
    }

    const { size } = fileStat;
    const shouldAppend = Boolean(cached) && size >= (cached?.offset ?? 0);
    const readFrom = shouldAppend ? (cached?.offset ?? 0) : 0;
    const previousRemainder = shouldAppend ? (cached?.remainder ?? "") : "";
    const previousLines = shouldAppend ? (cached?.recentLines ?? []) : [];
    const readSize = Math.max(0, size - readFrom);
    const fd = await open(sessionFile, "r");
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, readFrom);
    await fd.close();

    const chunk = buf.toString("utf-8");
    const cursor = advanceJsonlCursor(
      {
        offset: readFrom,
        remainder: previousRemainder,
        recentLines: previousLines,
      },
      chunk,
      CLAUDE_PHASE_RECENT_LINES,
    );
    const lines = cursor.recentLines;

    let lastResponseAt: number | undefined;
    let lastActivityAt: number | undefined;
    let phase: SessionPhase;
    const getContentTypes = (content: unknown): string[] => {
      if (!Array.isArray(content)) return [];
      return content
        .map((item) => {
          if (item && typeof item === "object" && "type" in item) {
            const type = (item as { type?: unknown }).type;
            return typeof type === "string" ? type : undefined;
          }
          return undefined;
        })
        .filter((value): value is string => Boolean(value));
    };

    // Walk backwards through the last events
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const type = entry.type;
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() / 1000 : undefined;

        // Track latest timestamps
        if (ts && !lastActivityAt) lastActivityAt = ts;
        if (ts && type === "assistant" && !lastResponseAt) lastResponseAt = ts;

        // Phase detection (only set once — first match wins)
        if (!phase) {
          if (type === "progress") {
            const data = entry.data;
            if (data?.type === "hook_progress") {
              phase = "tool";
            }
            continue;
          }

          if (type === "assistant") {
            const stopReason = entry.message?.stop_reason;
            const contentTypes = getContentTypes(entry.message?.content);

            if (stopReason === "tool_use") {
              const hasResult = lines.slice(i + 1).some((l) => {
                try {
                  const e = JSON.parse(l);
                  return (
                    e.type === "user" && getContentTypes(e.message?.content).includes("tool_result")
                  );
                } catch {
                  return false;
                }
              });

              if (!hasResult) phase = "permission";
              continue;
            }

            if (stopReason === null || stopReason === undefined) {
              if (contentTypes.includes("text") || contentTypes.includes("tool_use")) {
                phase = "thinking";
              }
            }

            if (stopReason === "end_turn") {
              phase = "done";
            }
          }

          if (type === "user") {
            phase = "thinking";
          }
        }

        // Stop early if we have everything
        if (phase && lastResponseAt && lastActivityAt) break;
      } catch {}
    }

    // If event timestamps were not parseable, fall back to the project JSONL mtime.
    if (!lastActivityAt) {
      lastActivityAt = fileStat.mtimeMs / 1000;
    }

    const decayedPhase = config
      ? resolvePhaseWithDecay(
          phase,
          cached?.result.phase,
          cached?.phaseDetectedAtMs,
          config.status.phaseDecay,
        )
      : phase;
    const resolvedPhase = resolvePhaseFromHistory(decayedPhase, cached?.history ?? [], Date.now());

    const nowMs = Date.now();
    const transition = updatePhaseHistory(
      cached?.result.phase,
      cached?.history ?? [],
      resolvedPhase,
      nowMs,
    );
    const result = { phase: resolvedPhase, lastResponseAt, lastActivityAt };
    claudePhaseCache.set(sessionFile, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      phaseDetectedAtMs: resolvedPhase ? nowMs : cached?.phaseDetectedAtMs,
      offset: cursor.offset,
      remainder: cursor.remainder,
      recentLines: cursor.recentLines,
      previousPhase: transition.previousPhase,
      history: transition.history,
      result,
    });
    return result;
  } catch {
    return {};
  }
}

/** Parse Claude Code session file for enriched data */
export async function parseClaudeSession(
  pid: number,
  config?: MarmonitorConfig,
): Promise<Partial<AgentSession>> {
  const sessionFile = getClaudeSessionRoots(config)
    .map((root) => join(root, `${pid}.json`))
    .find((candidate) => existsSync(candidate));
  if (!sessionFile) return {};
  try {
    const fileStat = await stat(sessionFile);
    const raw = await readFile(sessionFile, "utf-8");
    const data = JSON.parse(raw);

    const result: Partial<AgentSession> = {
      cwd: data.cwd,
      sessionId: data.sessionId,
      startedAt: data.startedAt ? data.startedAt / 1000 : undefined,
      lastActivityAt: fileStat.mtimeMs / 1000,
      sessionMatched: true,
    };

    if (data.sessionId && data.cwd) {
      const tokenData = await parseClaudeTokens(
        data.sessionId,
        data.cwd,
        data.startedAt ? data.startedAt / 1000 : undefined,
        config,
      );
      result.tokenUsage = tokenData.tokenUsage;
      result.model = tokenData.model;
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Claude Code session parsing, token extraction, and phase detection.
 */

import { existsSync } from "node:fs";
import { realpath as fsRealpath, open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

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
  CLAUDE_MATCH_GAP_SEC,
  CLAUDE_MATCH_TOP_DELTA_SEC,
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

async function listClaudeSessionCandidates(
  projectDirName: string,
  projectRoots: string[],
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const projectsDir of projectRoots) {
    const projectDir = join(projectsDir, projectDirName);
    if (!existsSync(projectDir)) continue;
    const files = await readdir(projectDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const candidatePath = join(projectDir, file);
      try {
        const fileStat = await stat(candidatePath);
        candidates.push({ path: candidatePath, mtimeMs: fileStat.mtimeMs });
      } catch {
        // skip candidate
      }
    }
  }

  return candidates;
}

function isDirectSessionFile(path: string | undefined, sessionId: string): boolean {
  return Boolean(path && basename(path) === `${sessionId}.jsonl`);
}

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
              binding: "direct",
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
  const registeredEntry = claudeSessionRegistry.get(sessionId);
  const registeredPath = registeredEntry?.filePath;
  if (registeredEntry?.binding === "direct" && registeredPath && existsSync(registeredPath)) {
    return registeredPath;
  }

  const projectDirName = await findClaudeProjectDir(cwd, sessionId, config);
  if (!projectDirName) {
    // No project dir found; fall back to mtime-matched registry entry if available
    if (registeredPath && existsSync(registeredPath)) return registeredPath;
    return undefined;
  }
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
        binding: "direct",
      });
      return directPath;
    }
  }

  // For a known sessionId, never guess another file by recency alone.
  // Provisional registry entries are allowed only when they were already
  // associated with this same session during an earlier match step.
  if (registeredEntry?.binding === "provisional" && registeredPath && existsSync(registeredPath)) {
    return registeredPath;
  }

  void startedAt;
  return undefined;
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
    let lastInputTokens: number | undefined = cached?.result.tokenUsage?.lastInputTokens;
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
      lastInputTokens = undefined;
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
        // Track most recent call's input_tokens for context % calculation
        if (usage.input_tokens != null) {
          lastInputTokens = usage.input_tokens;
        }

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
              lastInputTokens,
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

/**
 * Read the first line of a JSONL file to extract session metadata.
 * Returns undefined if the file can't be read or parsed.
 */
async function readJsonlSessionMeta(
  filePath: string,
): Promise<{ sessionId?: string; cwd?: string; timestamp?: string } | undefined> {
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fd = await open(filePath, "r");
    const buf = Buffer.alloc(4096);
    await fd.read(buf, 0, 4096, 0);
    const lines = buf
      .toString("utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8);
    const meta: { sessionId?: string; cwd?: string; timestamp?: string } = {};
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!meta.sessionId && typeof entry?.sessionId === "string")
          meta.sessionId = entry.sessionId;
        if (!meta.cwd && typeof entry?.cwd === "string") meta.cwd = entry.cwd;
        if (!meta.timestamp) {
          if (typeof entry?.timestamp === "string") meta.timestamp = entry.timestamp;
          else if (typeof entry?.snapshot?.timestamp === "string")
            meta.timestamp = entry.snapshot.timestamp;
        }
        if (meta.sessionId && meta.cwd && meta.timestamp) return meta;
      } catch {
        // ignore malformed line
      }
    }
    return meta.sessionId || meta.cwd || meta.timestamp ? meta : undefined;
  } catch {
    return undefined;
  } finally {
    await fd?.close().catch(() => {});
  }
}

/**
 * Stale-session override resolver.
 *
 * Picks a non-current jsonl when the current sessionId's metadata is stale
 * (e.g. just after /clear), but refuses to do so when the current jsonl
 * clearly belongs to this process or when the candidate jsonl is already
 * claimed in the registry. See local issue #103 / GH #56 for the misrouting
 * case this guards.
 *
 * Conservative guards layered on top of the legacy mtime-lead check:
 *  - F1: if currentDirectPath exists and its first-line timestamp is on or
 *        after processStartedAt, the current jsonl was authored by this
 *        process — keep it, do not override.
 *  - F2: if the override-candidate sessionId is already direct-bound in
 *        claudeSessionRegistry, refuse the override. Keeps the
 *        one-jsonl-per-sessionId invariant intact.
 *  - F3: anything ambiguous falls through to `undefined` (unresolved) —
 *        a missed match is safer than a misrouted one.
 */
async function chooseStaleSessionOverride(
  processCwd: string,
  currentSessionId: string | undefined,
  processStartedAt: number | undefined,
  config?: MarmonitorConfig,
  cycleClaimedSessionIds?: Set<string>,
  reservedSessionIds?: ReadonlySet<string>,
): Promise<{ sessionId: string; cwd?: string; timestamp?: string; filePath: string } | undefined> {
  const projectDirName = await findClaudeProjectDir(processCwd, currentSessionId, config);
  if (!projectDirName) return undefined;

  const candidates = await listClaudeSessionCandidates(
    projectDirName,
    getClaudeProjectRoots(config),
  );
  const recentPath = selectRecentSessionFile(candidates);
  if (!recentPath) return undefined;

  if (currentSessionId && isDirectSessionFile(recentPath, currentSessionId)) {
    return undefined;
  }

  const currentDirectPath =
    currentSessionId != null
      ? getClaudeProjectRoots(config)
          .map((projectsDir) => join(projectsDir, projectDirName, `${currentSessionId}.jsonl`))
          .find((candidate) => existsSync(candidate))
      : undefined;

  if (currentDirectPath) {
    let currentStat: Awaited<ReturnType<typeof stat>>;
    let recentStat: Awaited<ReturnType<typeof stat>>;
    try {
      [recentStat, currentStat] = await Promise.all([stat(recentPath), stat(currentDirectPath)]);
    } catch {
      return undefined;
    }

    // F1: a non-empty current jsonl whose first event is on or after the
    // process start belongs to this process. Same-cwd sibling sessions land
    // here and must not be routed onto another session's active jsonl.
    if (currentStat.size > 0 && processStartedAt !== undefined) {
      const currentMeta = await readJsonlSessionMeta(currentDirectPath);
      if (currentMeta?.timestamp) {
        const jsonlCreatedAtSec = new Date(currentMeta.timestamp).getTime() / 1000;
        if (Number.isFinite(jsonlCreatedAtSec)) {
          const CLOCK_SKEW_SEC = 60;
          if (jsonlCreatedAtSec >= processStartedAt - CLOCK_SKEW_SEC) return undefined;
        }
      }
    }

    const minLeadMs = 5 * 60 * 1000;
    const staleGapMs = 30 * 60 * 1000;
    if (recentStat.mtimeMs - currentStat.mtimeMs < minLeadMs) return undefined;
    if (Date.now() - currentStat.mtimeMs < staleGapMs) return undefined;
  }

  const recentMeta = await readJsonlSessionMeta(recentPath);
  if (!recentMeta?.sessionId) return undefined;
  if (recentMeta.sessionId === currentSessionId) return undefined;

  // #108: a session chosen by the stale override is just as capable of
  // collapsing two PIDs as a direct mtime match. The per-cycle ownership
  // check must therefore cover this legacy path as well.
  if (cycleClaimedSessionIds?.has(recentMeta.sessionId)) return undefined;

  // Active PID metadata and batch-selected mtime matches are reserved before
  // individual parsing begins. A stale legacy record must not steal one of
  // those sibling sessions merely because it acquired the mutex first.
  if (reservedSessionIds?.has(recentMeta.sessionId)) return undefined;

  // F2: the candidate sessionId is already direct-bound in the registry.
  // Overriding would let two sessionIds share one jsonl — the exact bug
  // in #103. Keeps the one-jsonl-per-sessionId invariant.
  const recentBinding = claudeSessionRegistry.get(recentMeta.sessionId);
  if (recentBinding?.binding === "direct") return undefined;

  return {
    sessionId: recentMeta.sessionId,
    cwd: recentMeta.cwd ?? processCwd,
    timestamp: recentMeta.timestamp,
    filePath: recentPath,
  };
}

export interface ClaudeMtimeMatchRequest {
  pid: number;
  cwd?: string;
  processStartedAt?: number;
}

export interface ClaudeMtimeMatch {
  filePath: string;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  lastActivityAt: number;
}

export interface ClaudeMtimeBatchOptions {
  /**
   * Live Claude PID count per cwd, counting every process that could own a
   * jsonl there — including PIDs this batch cannot score (unreadable lstart)
   * and PIDs already resolved through legacy pid.json. Sole ownership judged
   * from the batch's own group would miss those and wrongly relax.
   */
  liveClaudePidCountByCwd?: ReadonlyMap<string, number>;
  /** sessionIds already owned via legacy pid.json — never propose them. */
  reservedSessionIds?: ReadonlySet<string>;
}

type ClaudeMtimeCandidate = {
  path: string;
  mtimeMs: number;
  sessionId: string;
  cwd?: string;
  /** Absent when the first 8 lines carry no usable timestamp. */
  timestamp?: string;
};

/** How far one jsonl must lead the runner-up by mtime to win without timestamps. */
const CLAUDE_MTIME_FALLBACK_LEAD_MS = 5 * 60 * 1000;

type ClaudeMtimeScore = {
  scored: Array<ClaudeMtimeCandidate & { deltaSec: number }>;
  /** Candidates modified around or after the process start — the causal pool. */
  activeCount: number;
};

async function listClaudeMtimeCandidates(
  cwd: string,
  config?: MarmonitorConfig,
): Promise<ClaudeMtimeCandidate[]> {
  const projectDirName = await findClaudeProjectDir(cwd, undefined, config);
  if (!projectDirName) return [];

  const candidates = await listClaudeSessionCandidates(
    projectDirName,
    getClaudeProjectRoots(config),
  ).catch(() => []);
  const result: ClaudeMtimeCandidate[] = [];

  for (const candidate of candidates) {
    const meta = await readJsonlSessionMeta(candidate.path);
    if (!meta?.sessionId) continue;
    // A jsonl whose meta window carries no timestamp is still a real session —
    // dropping it here would hide the only candidate in a cwd and leave a live
    // PID permanently unbound. Keep it and let the mtime fallback score it.
    const timestampMs = meta.timestamp ? new Date(meta.timestamp).getTime() : Number.NaN;
    result.push({
      ...candidate,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      timestamp: Number.isFinite(timestampMs) ? meta.timestamp : undefined,
    });
  }

  return result;
}

function scoreClaudeMtimeCandidates(
  candidates: ClaudeMtimeCandidate[],
  processStartedAt: number,
): ClaudeMtimeScore {
  const startMs = processStartedAt * 1000;
  const active = candidates.filter(
    (candidate) => candidate.mtimeMs >= startMs - CLAUDE_SESSION_MTIME_MATCH_SEC * 1000,
  );
  const pool = active.length > 0 ? active : candidates;
  const activeCount = active.length;

  const scored = pool
    .filter((candidate) => candidate.timestamp !== undefined)
    .map((candidate) => ({
      ...candidate,
      deltaSec: Math.abs(
        new Date(candidate.timestamp as string).getTime() / 1000 - processStartedAt,
      ),
    }))
    .sort((a, b) => a.deltaSec - b.deltaSec);
  if (scored.length > 0) return { scored, activeCount };

  // No candidate carries a first-line timestamp, so proximity scoring is
  // impossible. Mirror matchClaudeSessionByMtime's fallback: commit only when
  // one jsonl clearly leads the rest by mtime. deltaSec 0 marks it as the sole
  // proposal — two PIDs reaching this path for the same jsonl still tie and
  // therefore still cancel each other out in the contention pass.
  const byMtime = [...pool].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = byMtime[0];
  const runnerUp = byMtime[1];
  if (!latest) return { scored: [], activeCount };
  if (runnerUp && latest.mtimeMs - runnerUp.mtimeMs < CLAUDE_MTIME_FALLBACK_LEAD_MS)
    return { scored: [], activeCount };
  return { scored: [{ ...latest, deltaSec: 0 }], activeCount };
}

/**
 * Whether a scored candidate list is safe to bind.
 *
 * `soleOwner` means this cwd holds exactly one live Claude PID and exactly one
 * actively-written jsonl. Collapse needs two of something, so neither failure
 * mode this guard exists for is reachable there — and the absolute proximity
 * cap would otherwise reject a resumed session whose jsonl predates its lstart
 * by hours or days, which is the common shape of a long-running session.
 * Dominance still applies in every other case; it is what actually prevents
 * two PIDs from landing on one sessionId.
 */
function isConfidentClaudeMtimeMatch(score: ClaudeMtimeScore, soleOwner = false): boolean {
  const top = score.scored[0];
  if (!top) return false;
  const second = score.scored[1];
  if (soleOwner) return !second;
  if (top.deltaSec > CLAUDE_MATCH_TOP_DELTA_SEC) return false;
  return !second || second.deltaSec - top.deltaSec >= CLAUDE_MATCH_GAP_SEC;
}

function toClaudeMtimeMatch(
  candidate: ClaudeMtimeCandidate,
  fallbackCwd: string,
): ClaudeMtimeMatch {
  return {
    filePath: candidate.path,
    sessionId: candidate.sessionId,
    cwd: candidate.cwd ?? fallbackCwd,
    startedAt: candidate.timestamp ? new Date(candidate.timestamp).getTime() / 1000 : undefined,
    lastActivityAt: candidate.mtimeMs / 1000,
  };
}

async function hydrateClaudeMtimeMatch(
  match: ClaudeMtimeMatch,
  config?: MarmonitorConfig,
): Promise<Partial<AgentSession>> {
  upsertSessionRegistryEntry(claudeSessionRegistry, {
    filePath: match.filePath,
    sessionId: match.sessionId,
    cwd: match.cwd,
    firstSeenOffset: 0,
    startedAt: match.startedAt,
    source: "claude",
    binding: basename(match.filePath).includes(match.sessionId) ? "direct" : "provisional",
  });

  const tokenData = await parseClaudeTokens(match.sessionId, match.cwd, match.startedAt, config);
  return {
    cwd: match.cwd,
    sessionId: match.sessionId,
    startedAt: match.startedAt,
    lastActivityAt: match.lastActivityAt,
    sessionMatched: true,
    tokenUsage: tokenData.tokenUsage,
    model: tokenData.model,
  };
}

/**
 * Select mtime matches for all same-cwd Claude PIDs in one scan cycle.
 *
 * A one-PID-at-a-time resolver is order-dependent: when process A's first
 * message is delayed, it can claim process B's fresher JSONL before B is
 * scanned. Resolve competing proposals as a batch instead. If two PIDs are
 * within the same dominance window for one JSONL, leave it unbound rather
 * than guessing an owner.
 */
export async function matchClaudeSessionsByMtime(
  requests: ClaudeMtimeMatchRequest[],
  config?: MarmonitorConfig,
  options?: ClaudeMtimeBatchOptions,
): Promise<Map<number, ClaudeMtimeMatch>> {
  const matches = new Map<number, ClaudeMtimeMatch>();
  const byCwd = new Map<string, ClaudeMtimeMatchRequest[]>();

  for (const request of requests) {
    if (!request.cwd || request.cwd === "unknown") continue;
    if (!Number.isFinite(request.processStartedAt)) continue;
    const group = byCwd.get(request.cwd) ?? [];
    group.push(request);
    byCwd.set(request.cwd, group);
  }

  for (const [cwd, group] of byCwd) {
    // A jsonl already owned through pid.json is not up for grabs; proposing it
    // here would let a heuristic match outrank an authoritative one.
    const candidates = (await listClaudeMtimeCandidates(cwd, config)).filter(
      (candidate) => !options?.reservedSessionIds?.has(candidate.sessionId),
    );
    const liveClaudePidCount = options?.liveClaudePidCountByCwd?.get(cwd) ?? group.length;
    const proposals: Array<{
      pid: number;
      candidate: ClaudeMtimeCandidate;
      deltaSec: number;
    }> = [];

    for (const request of group) {
      const processStartedAt = request.processStartedAt;
      if (processStartedAt === undefined) continue;
      const score = scoreClaudeMtimeCandidates(candidates, processStartedAt);
      // Knowing how many live PIDs share this cwd is what the batch pass buys
      // us; a per-PID resolver could never tell "sole owner" from "one of two".
      const soleOwner = liveClaudePidCount === 1 && score.activeCount === 1;
      if (isConfidentClaudeMtimeMatch(score, soleOwner)) {
        const top = score.scored[0];
        proposals.push({ pid: request.pid, candidate: top, deltaSec: top.deltaSec });
      }
    }

    const proposalsBySession = new Map<string, typeof proposals>();
    for (const proposal of proposals) {
      const contenders = proposalsBySession.get(proposal.candidate.sessionId) ?? [];
      contenders.push(proposal);
      proposalsBySession.set(proposal.candidate.sessionId, contenders);
    }

    for (const contenders of proposalsBySession.values()) {
      contenders.sort((a, b) => a.deltaSec - b.deltaSec);
      const winner = contenders[0];
      const runnerUp = contenders[1];
      // The owner must be clearly closer too. A one-second lstart difference
      // is normal process-start precision noise, not enough evidence to give
      // either PID a shared JSONL.
      if (runnerUp && runnerUp.deltaSec - winner.deltaSec < CLAUDE_MATCH_GAP_SEC) continue;
      matches.set(winner.pid, toClaudeMtimeMatch(winner.candidate, cwd));
    }
  }

  return matches;
}

/**
 * Match a Claude session by scanning JSONL files in the project directory.
 * When processStartedAt is available, matches by JSONL creation timestamp
 * (first-line timestamp) proximity to process start time.
 * Falls back to the most recently modified JSONL when no start time is available.
 *
 * Fail-closed dual threshold (local issue #108): a candidate is accepted only
 * when (a) its proximity to processStartedAt is within CLAUDE_MATCH_TOP_DELTA_SEC
 * AND (b) it dominates the runner-up by at least CLAUDE_MATCH_GAP_SEC. When
 * cycleClaimedSessionIds is supplied, any session already bound to another PID
 * in this scan cycle is excluded from the candidate pool — without this, two
 * same-cwd Claude PIDs whose lstart falls in the same second tiebreak onto the
 * same jsonl and the daemon snapshot collapses both PIDs onto one sessionId.
 */
export async function matchClaudeSessionByMtime(
  cwd: string,
  processStartedAt: number | undefined,
  config?: MarmonitorConfig,
  cycleClaimedSessionIds?: Set<string>,
): Promise<Partial<AgentSession> | undefined> {
  const projectDirName = await findClaudeProjectDir(cwd, undefined, config);
  if (!projectDirName) return undefined;

  const projectRoots = getClaudeProjectRoots(config);
  const candidates: Array<{ path: string; mtimeMs: number; sessionId: string }> = [];

  for (const projectsDir of projectRoots) {
    const projectDir = join(projectsDir, projectDirName);
    if (!existsSync(projectDir)) continue;
    try {
      const files = await readdir(projectDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        // Basename without ".jsonl" is the sessionId on disk; we use it to
        // skip files already claimed by another PID in this scan cycle.
        const sessionId = basename(file, ".jsonl");
        if (cycleClaimedSessionIds?.has(sessionId)) continue;
        try {
          const filePath = join(projectDir, file);
          const fileStat = await stat(filePath);
          candidates.push({ path: filePath, mtimeMs: fileStat.mtimeMs, sessionId });
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  if (candidates.length === 0) return undefined;

  let bestPath: string | undefined;

  if (processStartedAt) {
    const startMs = processStartedAt * 1000;
    // Pre-filter: only consider JSONL files modified after process start (with tolerance)
    const active = candidates.filter(
      (c) => c.mtimeMs >= startMs - CLAUDE_SESSION_MTIME_MATCH_SEC * 1000,
    );
    const pool = active.length > 0 ? active : candidates;

    // Read first lines to get creation timestamps and match by proximity
    const scored: Array<{ path: string; deltaSec: number; mtimeMs: number }> = [];
    for (const c of pool) {
      const firstLine = await readJsonlSessionMeta(c.path);
      if (!firstLine?.timestamp) continue;
      const createdAt = new Date(firstLine.timestamp).getTime() / 1000;
      scored.push({
        path: c.path,
        deltaSec: Math.abs(createdAt - processStartedAt),
        mtimeMs: c.mtimeMs,
      });
    }

    if (scored.length > 0) {
      scored.sort((a, b) => a.deltaSec - b.deltaSec);
      const top = scored[0];
      const second = scored[1];
      // Require (a) top close enough AND (b) dominant over the runner-up.
      // Without (b), two near-simultaneous Claude starts in the same cwd
      // both land on whichever jsonl wins the tiebreak — same-sessionId
      // collapse in the daemon snapshot. With (a)+(b), ambiguous matches
      // are deferred to a later scan cycle (snapshot sessionId stays
      // unset; CLI surfaces "session not ready") instead of misrouting.
      const dominates = !second || second.deltaSec - top.deltaSec >= CLAUDE_MATCH_GAP_SEC;
      if (top.deltaSec <= CLAUDE_MATCH_TOP_DELTA_SEC && dominates) {
        bestPath = top.path;
      }
      // Intentional fail-closed: if scored produced a result that does not
      // pass the dual threshold, do NOT fall back to mtime — fallback is
      // reserved for the case where no jsonl carries a timestamp at all.
    } else {
      // Fallback: no timestamp-scored match — only commit if one file clearly
      // leads by mtime to avoid mismatching when multiple sessions share cwd.
      pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const latest = pool[0];
      const second = pool[1];
      if (!second || latest.mtimeMs - second.mtimeMs >= 5 * 60 * 1000) {
        bestPath = latest.path;
      }
      // Ambiguous (two recent files within 5 min of each other) → bestPath stays undefined
    }
  } else {
    // No process start time — pick most recently modified, but only if unambiguous
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = candidates[0];
    const second = candidates[1];
    if (!second || latest.mtimeMs - second.mtimeMs >= 5 * 60 * 1000) {
      bestPath = candidates[0].path;
    }
  }

  if (!bestPath) return undefined;

  // Read first line for session metadata
  const entry = await readJsonlSessionMeta(bestPath);
  if (!entry?.sessionId) return undefined;

  try {
    const fileStat = await stat(bestPath);
    const sessionCwd = entry.cwd ?? cwd;

    const result: Partial<AgentSession> = {
      cwd: sessionCwd,
      sessionId: entry.sessionId,
      startedAt: entry.timestamp ? new Date(entry.timestamp).getTime() / 1000 : undefined,
      lastActivityAt: fileStat.mtimeMs / 1000,
      sessionMatched: true,
    };

    // Register in session registry for subsequent lookups
    upsertSessionRegistryEntry(claudeSessionRegistry, {
      filePath: bestPath,
      sessionId: entry.sessionId,
      cwd: sessionCwd,
      firstSeenOffset: 0,
      startedAt: result.startedAt,
      source: "claude",
      binding: basename(bestPath).includes(entry.sessionId) ? "direct" : "provisional",
    });

    const tokenData = await parseClaudeTokens(
      entry.sessionId,
      sessionCwd,
      result.startedAt,
      config,
    );
    result.tokenUsage = tokenData.tokenUsage;
    result.model = tokenData.model;

    return result;
  } catch {
    return undefined;
  }
}

/** Parse Claude Code session file for enriched data.
 *  cycleClaimedSessionIds (#108): per-scan-cycle Set of sessionIds already
 *  bound to another PID. Threaded to matchClaudeSessionByMtime so same-cwd
 *  multi-PID environments cannot collapse onto a single sessionId. */
export async function parseClaudeSession(
  pid: number,
  cwd?: string,
  processStartedAt?: number,
  config?: MarmonitorConfig,
  cycleClaimedSessionIds?: Set<string>,
  preselectedMtimeMatch?: ClaudeMtimeMatch | null,
  reservedSessionIds?: ReadonlySet<string>,
): Promise<Partial<AgentSession>> {
  // 1st: try legacy sessions/{pid}.json
  const sessionFile = getClaudeSessionRoots(config)
    .map((root) => join(root, `${pid}.json`))
    .find((candidate) => existsSync(candidate));
  if (sessionFile) {
    try {
      const fileStat = await stat(sessionFile);
      const raw = await readFile(sessionFile, "utf-8");
      const data = JSON.parse(raw);
      const processCwd = cwd ?? data.cwd;
      const sessionStartedAt = data.startedAt ? data.startedAt / 1000 : undefined;
      let resolvedSessionId: string | undefined = data.sessionId;
      let resolvedCwd: string | undefined = data.cwd;
      let resolvedStartedAt = sessionStartedAt;

      if (processCwd && processCwd !== "unknown") {
        const override = await chooseStaleSessionOverride(
          processCwd,
          data.sessionId,
          processStartedAt,
          config,
          cycleClaimedSessionIds,
          reservedSessionIds,
        );
        if (override) {
          resolvedSessionId = override.sessionId;
          resolvedCwd = override.cwd ?? processCwd;
          resolvedStartedAt = override.timestamp
            ? new Date(override.timestamp).getTime() / 1000
            : sessionStartedAt;
          upsertSessionRegistryEntry(claudeSessionRegistry, {
            filePath: override.filePath,
            sessionId: override.sessionId,
            cwd: resolvedCwd ?? processCwd,
            firstSeenOffset: 0,
            startedAt: resolvedStartedAt,
            source: "claude",
            binding: "provisional",
          });
        }
      }

      const result: Partial<AgentSession> = {
        cwd: resolvedCwd,
        sessionId: resolvedSessionId,
        startedAt: resolvedStartedAt,
        lastActivityAt: fileStat.mtimeMs / 1000,
        sessionMatched: true,
      };

      // Legacy PID records can be stale or duplicated. Returning a sessionId
      // that is already owned in this scan cycle would recreate the collapse
      // the mtime path prevents.
      if (resolvedSessionId && cycleClaimedSessionIds?.has(resolvedSessionId)) {
        return { cwd: resolvedCwd ?? processCwd, startedAt: resolvedStartedAt };
      }

      if (resolvedSessionId && resolvedCwd) {
        const tokenData = await parseClaudeTokens(
          resolvedSessionId,
          resolvedCwd,
          resolvedStartedAt,
          config,
        );
        result.tokenUsage = tokenData.tokenUsage;
        result.model = tokenData.model;
      }

      return result;
    } catch {
      // fall through to mtime-based matching
    }
  }

  // 2nd: match by JSONL mtime in project directory
  if (preselectedMtimeMatch !== undefined) {
    if (!preselectedMtimeMatch || cycleClaimedSessionIds?.has(preselectedMtimeMatch.sessionId)) {
      return {};
    }
    return hydrateClaudeMtimeMatch(preselectedMtimeMatch, config);
  }

  if (cwd && cwd !== "unknown") {
    const matched = await matchClaudeSessionByMtime(
      cwd,
      processStartedAt,
      config,
      cycleClaimedSessionIds,
    );
    if (matched) return matched;
  }

  return {};
}

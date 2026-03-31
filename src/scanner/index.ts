/**
 * AI agent process scanner.
 *
 * Detects running AI coding agents (Claude Code, Codex, Gemini),
 * enriches with session data (tokens, cwd, start time),
 * and determines activity status.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MarmonitorConfig } from "../config/index.js";
import { resolveRuntimeDataPaths } from "../config/index.js";
import { profileAsync } from "../perf.js";
import type { AgentSession, SessionPhase, TokenUsage } from "../types.js";

// ─── Re-exports (public API) ──────────────────────────────────────

export type { ScanOptions } from "./types.js";
export { detectAgentFromProcessSignature } from "./process.js";
export { propagateWorkerStateToParent } from "./group.js";
export { parseGeminiSessionContent } from "./gemini.js";

// ─── Internal imports ─────────────────────────────────────────────

import { selectCodexSession } from "../output/utils.js";
import { sessionEnrichmentCache } from "./cache.js";
import {
  detectClaudePhase,
  getClaudeSessionRoots,
  parseClaudeSession,
  parseClaudeTokens,
} from "./claude.js";
import { detectCodexPhase, indexCodexSessions } from "./codex.js";
import type { CodexSessionMeta } from "./codex.js";
import { parseGeminiSession } from "./gemini.js";
import { groupByParent } from "./group.js";
import {
  detectAgentFromProcessSignature as _detectAgent,
  detectRuntimeSource,
  getProcessCwd,
  getProcessStartTime,
} from "./process.js";
import {
  getPidUsage,
  getPidUsageCached,
  listProcesses,
  listProcessesCached,
} from "./runtime-snapshot.js";
import { detectCliStdoutPhase, determineStatus } from "./status.js";

import type { ScanOptions } from "./types.js";

// ─── Main Scanner ──────────────────────────────────────────────────

/** Scan for all running AI agent sessions */
export async function scanAgents(
  config: MarmonitorConfig,
  options: ScanOptions = {},
): Promise<AgentSession[]> {
  const enrichmentMode = options.enrichmentMode ?? "full";
  const isFullEnrichment = enrichmentMode === "full";
  const includeTokenUsage = options.includeTokenUsage ?? isFullEnrichment;
  const includeStdoutHeuristic = options.includeStdoutHeuristic ?? isFullEnrichment;
  const useSharedRuntimeSnapshots = options.useSharedRuntimeSnapshots ?? false;
  const seenPids = new Set<number>();

  // 1. Find running processes
  const processes = useSharedRuntimeSnapshots ? await listProcessesCached() : await listProcesses();

  // Filter to agent processes
  const agentProcesses: Array<{ proc: (typeof processes)[0]; agentName: string }> = [];
  for (const proc of processes) {
    const agentName = _detectAgent(proc, config);
    if (!agentName) continue;
    if (seenPids.has(proc.pid)) continue;
    seenPids.add(proc.pid);
    agentProcesses.push({ proc, agentName });
  }

  if (agentProcesses.length === 0 && !config.display.showDead) {
    return [];
  }

  const runtimePaths = resolveRuntimeDataPaths(config);

  // 2. Batch pidusage
  const pids = agentProcesses.map((a) => a.proc.pid);
  let usageMap: Record<number, { cpu: number; memory: number }> = {};
  if (pids.length > 0) {
    try {
      usageMap = useSharedRuntimeSnapshots
        ? await getPidUsageCached(pids)
        : await getPidUsage(pids);
    } catch {
      // some PIDs may have exited
    }
  }

  // 3. Pre-index Codex sessions (once, shared across all Codex processes)
  const codexProcesses = agentProcesses.filter((a) => a.agentName === "Codex");
  let codexSessions: CodexSessionMeta[] = [];
  let codexSessionsByCwd: Map<string, CodexSessionMeta[]> | undefined;
  if (codexProcesses.length > 0) {
    codexSessions = await profileAsync("scanAgents", "codex_index", () =>
      indexCodexSessions(config, { includeTokenUsage, runtimePaths }),
    );
    codexSessionsByCwd = new Map();
    for (const session of codexSessions) {
      const list = codexSessionsByCwd.get(session.cwd);
      if (list) {
        list.push(session);
      } else {
        codexSessionsByCwd.set(session.cwd, [session]);
      }
    }
  }

  // 4. Build sessions with enrichment (parallel)
  const sessionPromises = agentProcesses.map(async ({ proc, agentName }) => {
    const usage = usageMap[proc.pid];
    const cpuPercent = usage ? Math.round(usage.cpu * 10) / 10 : 0;
    const memoryMb = usage ? Math.round((usage.memory / (1024 * 1024)) * 10) / 10 : 0;

    // Skip tiny processes (spawners/wrappers)
    if (memoryMb < config.status.minMemoryMb) return null;

    let cwd = "unknown";
    let sessionId: string | undefined;
    let startedAt: number | undefined;
    let tokenUsage: TokenUsage | undefined;
    let model: string | undefined;
    let sessionMatched = false;
    let phase: SessionPhase;
    let lastResponseAt: number | undefined;
    let lastActivityAt: number | undefined;
    let codexSessionFile: string | undefined;
    const runtimeSource = detectRuntimeSource(agentName, proc.cmd);
    const cacheKey = `${agentName}:${proc.pid}`;
    const cachedEnrichment = sessionEnrichmentCache.get(cacheKey);

    if (!isFullEnrichment && cachedEnrichment) {
      if (cachedEnrichment.cwd) cwd = cachedEnrichment.cwd;
      sessionId = cachedEnrichment.sessionId;
      startedAt = cachedEnrichment.startedAt;
      tokenUsage = cachedEnrichment.tokenUsage;
      model = cachedEnrichment.model;
      sessionMatched = cachedEnrichment.sessionMatched ?? false;
      phase = cachedEnrichment.phase;
      lastResponseAt = cachedEnrichment.lastResponseAt;
      lastActivityAt = cachedEnrichment.lastActivityAt;
    } else if (agentName === "Claude Code") {
      const claudeData = await parseClaudeSession(proc.pid, config, {
        includeTokenUsage,
        runtimePaths,
      });
      if (claudeData.cwd) cwd = claudeData.cwd;
      if (cwd === "unknown") cwd = (await getProcessCwd(proc.pid)) ?? "unknown";
      sessionId = claudeData.sessionId;
      startedAt = claudeData.startedAt;
      tokenUsage = claudeData.tokenUsage;
      model = claudeData.model;
      sessionMatched = claudeData.sessionMatched ?? false;
      lastActivityAt = claudeData.lastActivityAt;

      if (sessionId && cwd) {
        const phaseResult = await detectClaudePhase(
          sessionId,
          cwd,
          startedAt,
          config,
          runtimePaths,
        );
        phase = phaseResult.phase;
        lastResponseAt = phaseResult.lastResponseAt;
        lastActivityAt = phaseResult.lastActivityAt ?? lastActivityAt;
      }
    } else if (agentName === "Codex") {
      cwd = cachedEnrichment?.cwd ?? (await getProcessCwd(proc.pid)) ?? "unknown";
      const cwdMatches = codexSessionsByCwd?.get(cwd) ?? [];
      let matched: CodexSessionMeta | undefined;
      if (cwdMatches.length === 1) {
        matched = cwdMatches[0];
      } else if (cwdMatches.length > 1) {
        const processStartTime = await getProcessStartTime(proc.pid, {
          sharedKey: `${proc.pid}:${proc.ppid}:${proc.name}:${proc.cmd ?? ""}`,
        });
        matched = selectCodexSession(cwd, processStartTime, cwdMatches);
      }
      if (matched) {
        sessionMatched = true;
        sessionId = matched.id;
        startedAt = matched.timestamp;
        lastActivityAt = matched.lastActivityAt;
        model = matched.model;
        codexSessionFile = matched.filePath;
        if (matched.totalTokenUsage) {
          tokenUsage = {
            inputTokens: matched.totalTokenUsage.input_tokens,
            outputTokens: matched.totalTokenUsage.output_tokens,
            cacheCreationTokens: 0,
            cacheReadTokens: matched.totalTokenUsage.cached_input_tokens ?? 0,
            totalTokens: matched.totalTokenUsage.total_tokens,
          };
        }
      }

      // Detect phase from session JSONL
      phase = await detectCodexPhase(codexSessionFile, config);
      if (includeStdoutHeuristic && phase !== "permission" && runtimeSource === "cli") {
        phase = (await detectCliStdoutPhase({ pid: proc.pid, cwd }, config)) ?? phase;
      }
    } else if (agentName === "Gemini") {
      cwd = cachedEnrichment?.cwd ?? (await getProcessCwd(proc.pid)) ?? "unknown";
      const geminiData = await parseGeminiSession(cwd, {
        includeTokenUsage,
      });
      startedAt =
        geminiData.startedAt ??
        (await getProcessStartTime(proc.pid, {
          sharedKey: `${proc.pid}:${proc.ppid}:${proc.name}:${proc.cmd ?? ""}`,
        }));
      sessionId = geminiData.sessionId;
      tokenUsage = geminiData.tokenUsage;
      model = geminiData.model;
      phase = geminiData.phase;
      lastResponseAt = geminiData.lastResponseAt;
      lastActivityAt = geminiData.lastActivityAt;
      sessionMatched = geminiData.sessionMatched ?? true;
      if (includeStdoutHeuristic && phase !== "permission") {
        phase = (await detectCliStdoutPhase({ pid: proc.pid, cwd }, config)) ?? phase;
      }
    }

    if (cwd === "unknown") {
      cwd = cachedEnrichment?.cwd ?? (await getProcessCwd(proc.pid)) ?? "unknown";
    }

    const statusBaseAt = lastActivityAt ?? lastResponseAt ?? startedAt;
    const elapsed = statusBaseAt ? Date.now() / 1000 - statusBaseAt : undefined;
    const status = determineStatus(cpuPercent, elapsed, sessionMatched, phase, config);

    const session = {
      agentName,
      pid: proc.pid,
      ppid: proc.ppid,
      cwd,
      cpuPercent,
      memoryMb,
      status,
      startedAt,
      sessionId,
      tokenUsage,
      model,
      sessionMatched,
      phase,
      lastResponseAt,
      lastActivityAt,
      runtimeSource,
    } as AgentSession;

    if (isFullEnrichment) {
      sessionEnrichmentCache.set(cacheKey, {
        cwd: session.cwd,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        tokenUsage: session.tokenUsage,
        model: session.model,
        sessionMatched: session.sessionMatched,
        phase: session.phase,
        lastResponseAt: session.lastResponseAt,
        lastActivityAt: session.lastActivityAt,
        runtimeSource: session.runtimeSource,
      });
    }

    return session;
  });

  const results = await profileAsync("scanAgents", "build_sessions", () =>
    Promise.all(sessionPromises),
  );
  const sessions: AgentSession[] = results.filter((s): s is AgentSession => s !== null);

  // 5. Check for dead sessions (Claude: session file exists but process gone)
  if (config.display.showDead) {
    for (const claudeSessionDir of getClaudeSessionRoots(config, runtimePaths)) {
      try {
        const files = await readdir(claudeSessionDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const pid = Number.parseInt(file.replace(".json", ""), 10);
          if (Number.isNaN(pid) || seenPids.has(pid)) continue;

          const isRunning = processes.some((p) => p.pid === pid);
          if (isRunning) continue;

          try {
            const raw = await readFile(join(claudeSessionDir, file), "utf-8");
            const data = JSON.parse(raw);

            let tokenUsage: TokenUsage | undefined;
            let model: string | undefined;
            if (data.sessionId && data.cwd) {
              const tokenData = await parseClaudeTokens(
                data.sessionId,
                data.cwd,
                undefined,
                config,
                runtimePaths,
              );
              tokenUsage = tokenData.tokenUsage;
              model = tokenData.model;
            }

            sessions.push({
              agentName: "Claude Code",
              pid,
              cwd: data.cwd ?? "unknown",
              cpuPercent: 0,
              memoryMb: 0,
              status: "Dead",
              sessionId: data.sessionId,
              startedAt: data.startedAt ? data.startedAt / 1000 : undefined,
              tokenUsage,
              model,
              sessionMatched: true,
            });
          } catch {
            // skip
          }
        }
      } catch {
        // session dir read error
      }
    }
  }

  // 6. Group by parent, then sort by config
  const grouped = groupByParent(sessions);

  const sortKey = config.display.sortBy;
  grouped.sort((a, b) => {
    switch (sortKey) {
      case "agent":
        return a.agentName.localeCompare(b.agentName) || a.cwd.localeCompare(b.cwd);
      case "status":
        return a.status.localeCompare(b.status) || a.cwd.localeCompare(b.cwd);
      case "pid":
        return a.pid - b.pid;
      default:
        return a.cwd.localeCompare(b.cwd);
    }
  });

  return grouped;
}

/**
 * AI agent process scanner.
 *
 * Detects running AI coding agents (Claude Code, Codex, Gemini),
 * enriches with session data (tokens, cwd, start time),
 * and determines activity status.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import pidusage from "pidusage";
import psList from "ps-list";
import type { MarmonitorConfig } from "../config/index.js";
import type { AgentSession, SessionPhase, TokenUsage } from "../types.js";

// ─── Re-exports (public API) ──────────────────────────────────────

export type { ScanOptions } from "./types.js";
export { detectAgentFromProcessSignature } from "./process.js";
export { propagateWorkerStateToParent } from "./group.js";
export { parseGeminiSessionContent } from "./gemini.js";

// ─── Internal imports ─────────────────────────────────────────────

import { claudeSessionRegistry, sessionEnrichmentCache } from "./cache.js";
import {
  detectClaudePhase,
  getClaudeSessionRoots,
  parseClaudeSession,
  parseClaudeTokens,
} from "./claude.js";
import {
  buildCodexBindingKey,
  markMissingCodexBindingsDead,
  selectCodexBindingSession,
  upsertCodexBindingRecord,
} from "./codex-binding-registry.js";
import { detectCodexPhase, indexCodexSessions, matchCodexSession } from "./codex.js";
import { promiseAllLimited } from "./concurrency.js";
import { parseGeminiSession } from "./gemini.js";
import { groupByParent } from "./group.js";
import { perfEnd, perfStart } from "./perf.js";
import {
  detectAgentFromProcessSignature as _detectAgent,
  detectRuntimeSource,
  getProcessCwd,
  getProcessStartTime,
} from "./process.js";
import { classifySessionTier } from "./session-tier.js";
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
  const codexBindingRegistry = options.codexBindingRegistry;
  const seenPids = new Set<number>();

  perfStart("scanAgents");

  // 1. Find running processes
  perfStart("ps-list");
  const processes = await psList();
  perfEnd("ps-list");

  // Filter to agent processes
  const agentProcesses: Array<{ proc: (typeof processes)[0]; agentName: string }> = [];
  for (const proc of processes) {
    const agentName = _detectAgent(proc, config);
    if (!agentName) continue;
    if (seenPids.has(proc.pid)) continue;
    seenPids.add(proc.pid);
    agentProcesses.push({ proc, agentName });
  }

  // 2. Batch pidusage
  perfStart("pidusage");
  const pids = agentProcesses.map((a) => a.proc.pid);
  let usageMap: Record<number, { cpu: number; memory: number }> = {};
  try {
    usageMap = await pidusage(pids);
  } catch {
    // some PIDs may have exited
  }
  perfEnd("pidusage");

  // 3. Pre-index Codex sessions (once, shared across all Codex processes)
  const codexCwdEntries = isFullEnrichment
    ? await promiseAllLimited(
        agentProcesses
          .filter((item) => item.agentName === "Codex")
          .map((item) => async () => ({
            pid: item.proc.pid,
            cwd: (await getProcessCwd(item.proc.pid)) ?? undefined,
          })),
        4,
      )
    : [];
  const resolvedCodexCwds = codexCwdEntries.flatMap((entry) => (entry ? [entry] : []));
  const activeCodexCwds = [
    ...new Set(
      resolvedCodexCwds.map((entry) => entry.cwd).filter((cwd): cwd is string => Boolean(cwd)),
    ),
  ];
  const codexCwdByPid = new Map(
    resolvedCodexCwds.filter((entry) => entry.cwd).map((entry) => [entry.pid, entry.cwd as string]),
  );
  perfStart("codex-index");
  const codexSessions = isFullEnrichment
    ? await indexCodexSessions(config, { activeCwds: activeCodexCwds })
    : [];
  perfEnd("codex-index");

  // 4. Build sessions with enrichment (concurrency limited)
  const sessionPromises = agentProcesses.map(({ proc, agentName }) => async () => {
    const usage = usageMap[proc.pid];
    const cpuPercent = usage ? Math.round(usage.cpu * 10) / 10 : 0;
    const memoryMb = usage ? Math.round((usage.memory / (1024 * 1024)) * 10) / 10 : 0;

    // Skip tiny processes (spawners/wrappers)
    if (memoryMb < config.status.minMemoryMb) return null;

    let cwd = "unknown";
    let sessionId: string | undefined;
    let startedAt: number | undefined;
    let processStartedAt: number | undefined;
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

    // Determine session tier for differential enrichment
    const tier = cachedEnrichment
      ? classifySessionTier(
          cachedEnrichment.lastActivityAt,
          Date.now() / 1000,
          cpuPercent,
          cachedEnrichment.phase,
        )
      : "hot"; // no cache = first time seeing this session, treat as hot

    // Cold session JSONL mtime check: detect activity without full enrichment
    let coldPromoted = false;
    if (tier === "cold" && cachedEnrichment?.sessionId && agentName === "Claude Code") {
      const regEntry = claudeSessionRegistry.get(cachedEnrichment.sessionId);
      if (regEntry?.filePath) {
        try {
          const fileStat = await stat(regEntry.filePath);
          const cachedActivity = (cachedEnrichment.lastActivityAt ?? 0) * 1000;
          if (fileStat.mtimeMs > cachedActivity + 1000) {
            coldPromoted = true; // JSONL changed → force enrichment
          }
        } catch {
          // file gone or inaccessible — keep cold
        }
      }
    }

    const useCachedEnrichment =
      cachedEnrichment && !coldPromoted && (!isFullEnrichment || tier === "cold");

    if (useCachedEnrichment) {
      if (cachedEnrichment.cwd) cwd = cachedEnrichment.cwd;
      sessionId = cachedEnrichment.sessionId;
      startedAt = cachedEnrichment.startedAt;
      processStartedAt = cachedEnrichment.processStartedAt;
      tokenUsage = cachedEnrichment.tokenUsage;
      model = cachedEnrichment.model;
      sessionMatched = cachedEnrichment.sessionMatched ?? false;
      phase = cachedEnrichment.phase;
      lastResponseAt = cachedEnrichment.lastResponseAt;
      lastActivityAt = cachedEnrichment.lastActivityAt;
    } else if (!isFullEnrichment && !cachedEnrichment) {
      // Light mode with no cache: skip expensive enrichment (lsof, JSONL, tmux)
      sessionMatched = true;
    } else if (agentName === "Claude Code") {
      // Get cwd and start time early so mtime-based matching can use them
      const processCwd = (await getProcessCwd(proc.pid)) ?? undefined;
      const processStartTime = await getProcessStartTime(proc.pid);
      const claudeData = await parseClaudeSession(proc.pid, processCwd, processStartTime, config);
      if (claudeData.cwd) cwd = claudeData.cwd;
      if (cwd === "unknown") cwd = processCwd ?? "unknown";
      sessionId = claudeData.sessionId;
      startedAt = claudeData.startedAt ?? processStartTime;
      tokenUsage = claudeData.tokenUsage;
      model = claudeData.model;
      sessionMatched = claudeData.sessionMatched ?? false;
      lastActivityAt = claudeData.lastActivityAt;

      if (sessionId && cwd) {
        const phaseResult = await detectClaudePhase(sessionId, cwd, startedAt, config);
        phase = phaseResult.phase;
        lastResponseAt = phaseResult.lastResponseAt;
        lastActivityAt = phaseResult.lastActivityAt ?? lastActivityAt;
      }
    } else if (agentName === "Codex") {
      cwd =
        cachedEnrichment?.cwd ??
        codexCwdByPid.get(proc.pid) ??
        (await getProcessCwd(proc.pid)) ??
        "unknown";
      processStartedAt = await getProcessStartTime(proc.pid);

      const matched =
        (codexBindingRegistry
          ? selectCodexBindingSession(
              codexBindingRegistry,
              proc.pid,
              processStartedAt,
              cwd,
              codexSessions,
            )
          : undefined) ?? matchCodexSession(cwd, processStartedAt, codexSessions);
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
      if (phase !== "permission" && runtimeSource === "cli") {
        phase = (await detectCliStdoutPhase({ pid: proc.pid, cwd }, config)) ?? phase;
      }

      if (codexBindingRegistry && matched) {
        upsertCodexBindingRecord(codexBindingRegistry, {
          pid: proc.pid,
          processStartedAt,
          cwd,
          matched,
          phase,
        });
      }
    } else if (agentName === "Gemini") {
      cwd = cachedEnrichment?.cwd ?? (await getProcessCwd(proc.pid)) ?? "unknown";
      const geminiData = await parseGeminiSession(cwd);
      startedAt = geminiData.startedAt ?? (await getProcessStartTime(proc.pid));
      sessionId = geminiData.sessionId;
      tokenUsage = geminiData.tokenUsage;
      model = geminiData.model;
      phase = geminiData.phase;
      lastResponseAt = geminiData.lastResponseAt;
      lastActivityAt = geminiData.lastActivityAt;
      sessionMatched = geminiData.sessionMatched ?? true;
      if (phase !== "permission") {
        phase = (await detectCliStdoutPhase({ pid: proc.pid, cwd }, config)) ?? phase;
      }
    }

    if (cwd === "unknown" && isFullEnrichment) {
      cwd = cachedEnrichment?.cwd ?? (await getProcessCwd(proc.pid)) ?? "unknown";
    }

    const statusBaseAt = lastActivityAt ?? lastResponseAt ?? startedAt;
    const elapsed = statusBaseAt ? Date.now() / 1000 - statusBaseAt : undefined;
    const status = determineStatus(cpuPercent, elapsed, sessionMatched, phase, config, agentName);

    const session = {
      agentName,
      pid: proc.pid,
      ppid: proc.ppid,
      cwd,
      cpuPercent,
      memoryMb,
      status,
      startedAt,
      processStartedAt,
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
        processStartedAt: session.processStartedAt,
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

  const concurrencyLimit = isFullEnrichment ? 8 : 4;
  const results = await promiseAllLimited(sessionPromises, concurrencyLimit);
  const sessions: AgentSession[] = results.filter((s): s is AgentSession => s !== null);

  if (codexBindingRegistry) {
    const aliveCodexKeys = new Set(
      sessions
        .filter((session) => session.agentName === "Codex")
        .map((session) => buildCodexBindingKey(session.pid, session.processStartedAt)),
    );
    markMissingCodexBindingsDead(codexBindingRegistry, aliveCodexKeys);
  }

  // 5. Check for dead sessions (Claude: session file exists but process gone)
  if (config.display.showDead) {
    for (const claudeSessionDir of getClaudeSessionRoots(config)) {
      if (!existsSync(claudeSessionDir)) continue;
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

  perfEnd("scanAgents");
  return grouped;
}

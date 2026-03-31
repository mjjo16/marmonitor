/**
 * Codex session parsing, indexing, and phase detection.
 */

import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MarmonitorConfig, RuntimeDataPaths } from "../config/index.js";
import { resolveRuntimeDataPaths } from "../config/index.js";
import {
  advanceJsonlCursor,
  resolvePhaseFromHistory,
  resolvePhaseWithDecay,
  selectCodexSession,
  updatePhaseHistory,
  upsertSessionRegistryEntry,
} from "../output/utils.js";
import { profileAsync } from "../perf.js";
import type { SessionPhase } from "../types.js";
import {
  CODEX_INDEX_TTL_MS,
  CODEX_PHASE_RECENT_LINES,
  HOME,
  codexIndexCache,
  codexPhaseCache,
  codexSessionFileCache,
  codexSessionRegistry,
} from "./cache.js";
import type { CodexSessionMeta } from "./cache.js";
import { readSharedCache, writeSharedCache } from "./shared-cache.js";

export type { CodexSessionMeta } from "./cache.js";

const CODEX_SHARED_PHASE_TTL_MS = 60_000;

interface CodexIndexOptions {
  includeTokenUsage?: boolean;
  runtimePaths?: RuntimeDataPaths;
}

interface CodexPhaseCacheOptions {
  cacheRoot?: string;
  nowMs?: number;
  openFile?: typeof open;
  statFile?: typeof stat;
}

export function getCodexSessionRoots(
  config?: MarmonitorConfig,
  runtimePaths?: RuntimeDataPaths,
): string[] {
  if (runtimePaths) return runtimePaths.codexSessions;
  return config
    ? resolveRuntimeDataPaths(config).codexSessions
    : [join(HOME, ".codex", "sessions")];
}

/** Detect Codex session phase from session JSONL */
export async function detectCodexPhase(
  sessionFilePath: string | undefined,
  config?: MarmonitorConfig,
  options: CodexPhaseCacheOptions = {},
): Promise<SessionPhase> {
  return await profileAsync("codex", "detectCodexPhase", async () => {
    if (!sessionFilePath || !existsSync(sessionFilePath)) return undefined;

    try {
      const nowMs = options.nowMs ?? Date.now();
      const statFile = options.statFile ?? stat;
      const openFile = options.openFile ?? open;
      const fileStat = await statFile(sessionFilePath);
      const cached = codexPhaseCache.get(sessionFilePath);
      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        return config
          ? resolvePhaseWithDecay(
              cached.result.phase,
              cached.result.phase,
              cached.phaseDetectedAtMs,
              config.status.phaseDecay,
            )
          : cached.result.phase;
      }

      const sharedKey = `${sessionFilePath}:${fileStat.mtimeMs}:${fileStat.size}`;
      const sharedCached = await readSharedCache<SessionPhase>(
        "codex-phase",
        sharedKey,
        CODEX_SHARED_PHASE_TTL_MS,
        {
          cacheRoot: options.cacheRoot,
          nowMs,
        },
      );
      if (sharedCached) {
        codexPhaseCache.set(sessionFilePath, {
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          phaseDetectedAtMs: sharedCached.value ? sharedCached.checkedAt : undefined,
          offset: fileStat.size,
          remainder: "",
          recentLines: [],
          previousPhase: sharedCached.value,
          history: sharedCached.value
            ? [{ phase: sharedCached.value, at: sharedCached.checkedAt }]
            : [],
          result: { phase: sharedCached.value },
        });
        return config
          ? resolvePhaseWithDecay(
              sharedCached.value,
              sharedCached.value,
              sharedCached.value ? sharedCached.checkedAt : undefined,
              config.status.phaseDecay,
            )
          : sharedCached.value;
      }

      const { size } = fileStat;
      const shouldAppend = Boolean(cached) && size >= (cached?.offset ?? 0);
      const readFrom = shouldAppend ? (cached?.offset ?? 0) : 0;
      const previousRemainder = shouldAppend ? (cached?.remainder ?? "") : "";
      const previousLines = shouldAppend ? (cached?.recentLines ?? []) : [];
      const readSize = Math.max(0, size - readFrom);
      const fd = await openFile(sessionFilePath, "r");
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
        CODEX_PHASE_RECENT_LINES,
      );
      const lines = cursor.recentLines;
      let phase: SessionPhase;

      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
        try {
          const entry = JSON.parse(lines[i]);

          if (entry.type === "event_msg") {
            const payloadType = entry.payload?.type;
            if (payloadType === "exec_command" || payloadType === "tool_call") {
              phase = "tool";
              break;
            }
            if (payloadType === "token_count") {
              phase = "done";
              break;
            }
          }

          if (entry.type === "response_item") {
            phase = "thinking";
            break;
          }
        } catch {}
      }
      const decayedPhase = config
        ? resolvePhaseWithDecay(
            phase,
            cached?.result.phase,
            cached?.phaseDetectedAtMs,
            config.status.phaseDecay,
          )
        : phase;
      const resolvedPhase = resolvePhaseFromHistory(decayedPhase, cached?.history ?? [], nowMs);

      const transition = updatePhaseHistory(
        cached?.result.phase,
        cached?.history ?? [],
        resolvedPhase,
        nowMs,
      );
      codexPhaseCache.set(sessionFilePath, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        phaseDetectedAtMs: resolvedPhase ? nowMs : cached?.phaseDetectedAtMs,
        offset: cursor.offset,
        remainder: cursor.remainder,
        recentLines: cursor.recentLines,
        previousPhase: transition.previousPhase,
        history: transition.history,
        result: { phase: resolvedPhase },
      });
      await writeSharedCache("codex-phase", sharedKey, resolvedPhase, {
        cacheRoot: options.cacheRoot,
        nowMs,
      });
      return resolvedPhase;
    } catch {
      return undefined;
    }
  });
}

/** Build index of recent Codex sessions (last 7 days) */
export async function indexCodexSessions(
  config?: MarmonitorConfig,
  options: CodexIndexOptions = {},
): Promise<CodexSessionMeta[]> {
  return await profileAsync("codex", "indexCodexSessions", async () => {
    const includeTokenUsage = options.includeTokenUsage !== false;
    const cachedIndex = includeTokenUsage
      ? codexIndexCache.full
      : (codexIndexCache.light ?? codexIndexCache.full);
    if (cachedIndex && Date.now() - cachedIndex.builtAt < CODEX_INDEX_TTL_MS) {
      return cachedIndex.sessions;
    }

    const sessionRoots = getCodexSessionRoots(config, options.runtimePaths);

    const metas: CodexSessionMeta[] = [];
    const now = new Date();

    const parseCodexSessionMeta = (
      raw: string,
      filePath: string,
      fileStat: Awaited<ReturnType<typeof stat>>,
      includeTokens: boolean,
    ): CodexSessionMeta | undefined => {
      const fileMtimeMs = Number(fileStat.mtimeMs);
      const fileSize = Number(fileStat.size);
      const lines = raw.trim().split("\n");
      const meta: Partial<CodexSessionMeta> = { filePath };
      let lastTokenCount: CodexSessionMeta["totalTokenUsage"];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          if (entry.type === "session_meta") {
            meta.id = entry.payload?.id;
            meta.cwd = entry.payload?.cwd;
            meta.model = entry.payload?.model_provider;
            if (entry.payload?.timestamp) {
              meta.timestamp = new Date(entry.payload.timestamp).getTime() / 1000;
            }
          }

          if (entry.type === "turn_context" && entry.payload?.model) {
            meta.model = entry.payload.model;
          }

          if (
            includeTokens &&
            entry.type === "event_msg" &&
            entry.payload?.type === "token_count"
          ) {
            lastTokenCount = entry.payload.info.total_token_usage;
          }

          if (meta.id && meta.cwd && meta.timestamp && (!includeTokens || lastTokenCount)) {
            break;
          }
        } catch {
          // skip
        }
      }

      if (!meta.id || !meta.cwd || !meta.timestamp) return undefined;

      return {
        filePath,
        id: meta.id,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        lastActivityAt: fileMtimeMs / 1000,
        totalTokenUsage: includeTokens ? lastTokenCount : undefined,
        model: meta.model,
        mtimeMs: fileMtimeMs,
        size: fileSize,
      } as CodexSessionMeta & { mtimeMs: number; size: number };
    };

    const readCodexSessionMeta = async (
      filePath: string,
      fileStat: Awaited<ReturnType<typeof stat>>,
    ): Promise<CodexSessionMeta | undefined> => {
      const fileMtimeMs = Number(fileStat.mtimeMs);
      const fileSize = Number(fileStat.size);
      const cachedMeta = codexSessionFileCache.get(filePath);
      if (
        cachedMeta?.timestamp &&
        (cachedMeta as CodexSessionMeta & { mtimeMs?: number; size?: number }).mtimeMs ===
          fileMtimeMs &&
        (cachedMeta as CodexSessionMeta & { mtimeMs?: number; size?: number }).size === fileSize &&
        (!includeTokenUsage || cachedMeta.totalTokenUsage)
      ) {
        return cachedMeta;
      }

      if (!includeTokenUsage) {
        try {
          const fd = await open(filePath, "r");
          try {
            const readSize = Math.min(fileSize, 16_384);
            const buf = Buffer.alloc(readSize);
            const { bytesRead } = await fd.read(buf, 0, readSize, 0);
            const parsed = parseCodexSessionMeta(
              buf.toString("utf-8", 0, bytesRead),
              filePath,
              fileStat,
              false,
            );
            if (parsed) return parsed;
          } finally {
            await fd.close();
          }
        } catch {
          // fall back to full read
        }
      }

      const raw = await readFile(filePath, "utf-8");
      return parseCodexSessionMeta(raw, filePath, fileStat, includeTokenUsage);
    };

    try {
      for (const sessionsDir of sessionRoots) {
        for (let daysBack = 0; daysBack < 7; daysBack++) {
          const d = new Date(now.getTime() - daysBack * 86400000);
          const yyyy = d.getFullYear().toString();
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          const dayDir = join(sessionsDir, yyyy, mm, dd);

          let files: string[];
          try {
            files = await readdir(dayDir);
          } catch {
            continue;
          }
          for (const f of files) {
            if (!f.endsWith(".jsonl")) continue;
            const filePath = join(dayDir, f);

            try {
              const fileStat = await stat(filePath);
              const parsed = await readCodexSessionMeta(filePath, fileStat);
              if (parsed) {
                codexSessionFileCache.set(filePath, parsed);
                upsertSessionRegistryEntry(codexSessionRegistry, {
                  filePath,
                  sessionId: parsed.id,
                  cwd: parsed.cwd,
                  firstSeenOffset: 0,
                  startedAt: parsed.timestamp,
                  model: parsed.model,
                  source: "codex",
                });
                metas.push(parsed);
              }
            } catch {
              // skip file
            }
          }
        }
      }
    } catch {
      // sessions dir error
    }

    const cacheEntry = {
      builtAt: Date.now(),
      sessions: metas,
    };
    if (includeTokenUsage) {
      codexIndexCache.full = cacheEntry;
      codexIndexCache.light = cacheEntry;
    } else {
      codexIndexCache.light = cacheEntry;
    }
    return metas;
  });
}

/** Match a Codex process to a session by cwd + closest timestamp */
export function matchCodexSession(
  processCwd: string,
  processStartTime: number | undefined,
  sessions: CodexSessionMeta[],
): CodexSessionMeta | undefined {
  return selectCodexSession(processCwd, processStartTime, sessions);
}

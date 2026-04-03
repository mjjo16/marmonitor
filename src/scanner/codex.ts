/**
 * Codex session parsing, indexing, and phase detection.
 */

import { existsSync, readdirSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { indexCodexSessionsFromSqlite } from "./codex-sqlite.js";

import type { MarmonitorConfig } from "../config/index.js";
import { resolveRuntimeDataPaths } from "../config/index.js";
import {
  advanceJsonlCursor,
  resolvePhaseFromHistory,
  resolvePhaseWithDecay,
  selectCodexSession,
  updatePhaseHistory,
  upsertSessionRegistryEntry,
} from "../output/utils.js";
import type { SessionPhase } from "../types.js";
import {
  CODEX_INDEX_TTL_MS,
  CODEX_PHASE_RECENT_LINES,
  HOME,
  codexIndexCache,
  codexPhaseCache,
  codexSessionFileCache,
  codexSessionRegistry,
  setCodexIndexCache,
} from "./cache.js";
import type { CodexSessionMeta } from "./cache.js";

export type { CodexSessionMeta } from "./cache.js";

const CODEX_SQLITE_RECENT_DAYS = 7;

export function getCodexSessionRoots(config?: MarmonitorConfig): string[] {
  return config
    ? resolveRuntimeDataPaths(config).codexSessions
    : [join(HOME, ".codex", "sessions")];
}

/** Detect Codex session phase from session JSONL */
export async function detectCodexPhase(
  sessionFilePath: string | undefined,
  config?: MarmonitorConfig,
): Promise<SessionPhase> {
  if (!sessionFilePath || !existsSync(sessionFilePath)) return undefined;

  try {
    const fileStat = await stat(sessionFilePath);
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

    const { size } = fileStat;
    const shouldAppend = Boolean(cached) && size >= (cached?.offset ?? 0);
    const readFrom = shouldAppend ? (cached?.offset ?? 0) : 0;
    const previousRemainder = shouldAppend ? (cached?.remainder ?? "") : "";
    const previousLines = shouldAppend ? (cached?.recentLines ?? []) : [];
    const readSize = Math.max(0, size - readFrom);
    const fd = await open(sessionFilePath, "r");
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
    const resolvedPhase = resolvePhaseFromHistory(decayedPhase, cached?.history ?? [], Date.now());

    const nowMs = Date.now();
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
    return resolvedPhase;
  } catch {
    return undefined;
  }
}

/** Find the latest Codex state SQLite DB path */
function findCodexStateDb(): string | undefined {
  const codexDir = join(homedir(), ".codex");
  try {
    const files = readdirSync(codexDir)
      .filter((f) => f.startsWith("state_") && f.endsWith(".sqlite"))
      .sort()
      .reverse();
    return files.length > 0 ? join(codexDir, files[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** Build index of Codex sessions (SQLite primary, JSONL fallback) */
export async function indexCodexSessions(
  config?: MarmonitorConfig,
  options?: { activeCwds?: string[] },
): Promise<CodexSessionMeta[]> {
  const activeCwds = [...new Set((options?.activeCwds ?? []).filter(Boolean))];
  const hasTargetedFilter = activeCwds.length > 0;

  if (
    !hasTargetedFilter &&
    codexIndexCache &&
    Date.now() - codexIndexCache.builtAt < CODEX_INDEX_TTL_MS
  ) {
    return codexIndexCache.sessions;
  }

  const hasExplicitSessionRoots = Boolean(config?.paths.codexSessions?.length);

  // Primary: SQLite threads table
  const dbPath = hasExplicitSessionRoots ? undefined : findCodexStateDb();
  if (dbPath) {
    const sqliteSessions = await indexCodexSessionsFromSqlite(dbPath, {
      recentUpdatedAfter: Math.floor(Date.now() / 1000) - CODEX_SQLITE_RECENT_DAYS * 86400,
      includeCwds: activeCwds,
    });
    if (sqliteSessions.length > 0) {
      // Register sessions for phase detection and cwd lookup
      for (const s of sqliteSessions) {
        codexSessionFileCache.set(s.filePath, { ...s, mtimeMs: undefined, size: undefined });
        upsertSessionRegistryEntry(codexSessionRegistry, {
          filePath: s.filePath,
          sessionId: s.id,
          cwd: s.cwd,
          firstSeenOffset: 0,
          startedAt: s.timestamp,
          model: s.model,
          source: "codex",
        });
      }
      if (!hasTargetedFilter) {
        setCodexIndexCache({ builtAt: Date.now(), sessions: sqliteSessions });
      }
      return sqliteSessions;
    }
  }

  // Fallback: JSONL directory scan (last 7 days)
  const sessionRoots = getCodexSessionRoots(config);
  if (!sessionRoots.some((sessionsDir) => existsSync(sessionsDir))) return [];

  const metas: CodexSessionMeta[] = [];
  const now = new Date();

  try {
    for (const sessionsDir of sessionRoots) {
      for (let daysBack = 0; daysBack < 7; daysBack++) {
        const d = new Date(now.getTime() - daysBack * 86400000);
        const yyyy = d.getFullYear().toString();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const dayDir = join(sessionsDir, yyyy, mm, dd);

        if (!existsSync(dayDir)) continue;

        const files = await readdir(dayDir);
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const filePath = join(dayDir, f);

          try {
            const fileStat = await stat(filePath);
            const cachedMeta = codexSessionFileCache.get(filePath);
            if (
              cachedMeta?.timestamp &&
              (cachedMeta as CodexSessionMeta & { mtimeMs?: number; size?: number }).mtimeMs ===
                fileStat.mtimeMs &&
              (cachedMeta as CodexSessionMeta & { mtimeMs?: number; size?: number }).size ===
                fileStat.size
            ) {
              metas.push(cachedMeta);
              continue;
            }

            const raw = await readFile(filePath, "utf-8");
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

                if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
                  lastTokenCount = entry.payload.info.total_token_usage;
                }
              } catch {
                // skip
              }
            }

            if (meta.id && meta.cwd && meta.timestamp) {
              const parsed = {
                filePath,
                id: meta.id,
                cwd: meta.cwd,
                timestamp: meta.timestamp,
                lastActivityAt: fileStat.mtimeMs / 1000,
                totalTokenUsage: lastTokenCount,
                model: meta.model,
                mtimeMs: fileStat.mtimeMs,
                size: fileStat.size,
              } as CodexSessionMeta & { mtimeMs: number; size: number };
              codexSessionFileCache.set(filePath, parsed);
              upsertSessionRegistryEntry(codexSessionRegistry, {
                filePath,
                sessionId: meta.id,
                cwd: meta.cwd,
                firstSeenOffset: 0,
                startedAt: meta.timestamp,
                model: meta.model,
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

  setCodexIndexCache({
    builtAt: Date.now(),
    sessions: metas,
  });
  return metas;
}

/** Match a Codex process to a session by cwd + closest timestamp */
export function matchCodexSession(
  processCwd: string,
  processStartTime: number | undefined,
  sessions: CodexSessionMeta[],
): CodexSessionMeta | undefined {
  return selectCodexSession(processCwd, processStartTime, sessions);
}

/**
 * Cache instances and internal cache types for the scanner modules.
 */

import { homedir } from "node:os";
import type { SessionRegistryEntry } from "../output/utils.js";
import type { AgentSession, SessionPhase, TokenUsage } from "../types.js";
import { BoundedMap } from "./bounded-map.js";

// ─── Shared Constants ──────────────────────────────────────────────

export const HOME = homedir();
export const PROCESS_CWD_TTL_MS = 60_000;
export const PROCESS_START_TTL_MS = 300_000;
export const CODEX_INDEX_TTL_MS = 30_000;
export const CLAUDE_SESSION_MTIME_MATCH_SEC = 120;
export const CLAUDE_SESSION_AMBIGUITY_GAP_SEC = 300;
export const CLAUDE_PHASE_RECENT_LINES = 50;
export const CODEX_PHASE_RECENT_LINES = 30;
export const RECENT_ACTIVITY_ACTIVE_SEC = 180;

// ─── Cache Entry Types ─────────────────────────────────────────────

export interface FileTokenCacheEntry {
  mtimeMs: number;
  size: number;
  result: { tokenUsage?: TokenUsage; model?: string };
}

export interface PhaseResult {
  phase?: SessionPhase;
  lastResponseAt?: number;
  lastActivityAt?: number;
}

export interface PhaseCacheEntry {
  mtimeMs: number;
  size: number;
  phaseDetectedAtMs?: number;
  offset: number;
  remainder: string;
  recentLines: string[];
  previousPhase?: SessionPhase;
  history: Array<{ phase: Exclude<SessionPhase, undefined>; at: number }>;
  result: PhaseResult;
}

export interface ProcessCwdCacheEntry {
  checkedAt: number;
  cwd?: string;
}

export interface ProcessStartCacheEntry {
  checkedAt: number;
  startedAt?: number;
}

export interface StdoutHeuristicCacheEntry {
  checkedAt: number;
  phase?: SessionPhase;
}

/** Codex session metadata (parsed from JSONL first lines) */
export interface CodexSessionMeta {
  filePath: string;
  id: string;
  cwd: string;
  timestamp: number; // epoch seconds
  lastActivityAt?: number;
  totalTokenUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  model?: string;
}

// ─── Cache Instances ───────────────────────────────────────────────

export const claudeProjectDirCache = new BoundedMap<string, string>(64);
export const claudeTokenCache = new BoundedMap<string, FileTokenCacheEntry>(64);
export const claudePhaseCache = new BoundedMap<string, PhaseCacheEntry>(64);
export const codexPhaseCache = new BoundedMap<string, PhaseCacheEntry>(64);
export const geminiProjectDirCache = new BoundedMap<string, string>(64);
export const codexSessionFileCache = new BoundedMap<
  string,
  CodexSessionMeta & { mtimeMs?: number; size?: number }
>(256);
export const claudeSessionRegistry = new BoundedMap<string, SessionRegistryEntry>(128);
export const codexSessionRegistry = new BoundedMap<string, SessionRegistryEntry>(128);
export const processCwdCache = new BoundedMap<number, ProcessCwdCacheEntry>(128);
export const processStartCache = new BoundedMap<number, ProcessStartCacheEntry>(128);
export const stdoutHeuristicCache = new BoundedMap<number, StdoutHeuristicCacheEntry>(64);
export const sessionEnrichmentCache = new BoundedMap<string, Partial<AgentSession>>(64);

// ─── Codex Index Cache ─────────────────────────────────────────────

export interface CodexIndexCacheEntry {
  builtAt: number;
  sessions: CodexSessionMeta[];
}

export const codexIndexCache = {
  full: undefined as CodexIndexCacheEntry | undefined,
  light: undefined as CodexIndexCacheEntry | undefined,
};

export function setCodexIndexCache(
  value:
    | {
        full?: CodexIndexCacheEntry;
        light?: CodexIndexCacheEntry;
      }
    | undefined,
): void {
  codexIndexCache.full = value?.full;
  codexIndexCache.light = value?.light;
}

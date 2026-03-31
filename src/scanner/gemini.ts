/**
 * Gemini session parsing and phase detection.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { profileAsync } from "../perf.js";
import type { AgentSession, SessionPhase, TokenUsage } from "../types.js";
import { HOME, geminiProjectDirCache } from "./cache.js";

export interface GeminiSessionMeta {
  filePath: string;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  lastActivityAt?: number;
  lastResponseAt?: number;
  tokenUsage?: TokenUsage;
  model?: string;
  phase?: SessionPhase;
}

interface GeminiParseOptions {
  includeTokenUsage?: boolean;
  tmpRoot?: string;
}

type GeminiMessage = {
  timestamp?: string;
  type?: string;
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    total?: number;
  };
  toolCalls?: unknown[];
};

export function toEpochSec(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed / 1000;
}

export function parseGeminiSessionContent(
  raw: string,
  options: GeminiParseOptions = {},
): Partial<GeminiSessionMeta> {
  const includeTokenUsage = options.includeTokenUsage !== false;
  try {
    const data = JSON.parse(raw);
    const messages = Array.isArray(data.messages)
      ? (data.messages as GeminiMessage[]).filter((msg): msg is GeminiMessage => msg != null)
      : [];
    const latestMessage = messages.at(-1);
    const latestGeminiMessage = [...messages].reverse().find((msg) => msg.type === "gemini");
    const lastActivityAt =
      toEpochSec(data.lastUpdated) ??
      [...messages]
        .map((msg) => toEpochSec(msg.timestamp))
        .filter((value): value is number => value !== undefined)
        .at(-1);
    const lastResponseAt = toEpochSec(latestGeminiMessage?.timestamp);
    // Phase priority: done (last message is gemini response) > thinking > tool
    // A gemini response with toolCalls means the tool already ran and gemini answered.
    const phase =
      latestMessage?.type === "user"
        ? "thinking"
        : latestMessage?.type === "gemini" || latestMessage?.type === "error"
          ? "done"
          : latestGeminiMessage?.toolCalls && latestGeminiMessage.toolCalls.length > 0
            ? "tool"
            : undefined;

    return {
      sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
      startedAt: toEpochSec(data.startTime),
      lastActivityAt,
      lastResponseAt,
      model: includeTokenUsage ? latestGeminiMessage?.model : undefined,
      tokenUsage:
        includeTokenUsage && latestGeminiMessage?.tokens
          ? {
              inputTokens: latestGeminiMessage.tokens.input ?? 0,
              outputTokens: latestGeminiMessage.tokens.output ?? 0,
              cacheCreationTokens: 0,
              cacheReadTokens: latestGeminiMessage.tokens.cached ?? 0,
              totalTokens: latestGeminiMessage.tokens.total ?? 0,
            }
          : undefined,
      phase,
    };
  } catch {
    return {};
  }
}

export async function resolveGeminiProjectDir(
  cwd: string,
  options: Pick<GeminiParseOptions, "tmpRoot"> = {},
): Promise<string | undefined> {
  return await profileAsync("gemini", "resolveGeminiProjectDir", async () => {
    const geminiTmpRoot = options.tmpRoot ?? join(HOME, ".gemini", "tmp");
    const cacheKey = `${geminiTmpRoot}::${cwd}`;
    const cachedProjectDir = geminiProjectDirCache.get(cacheKey);
    if (cachedProjectDir) {
      const cachedProjectRootFile = join(cachedProjectDir, ".project_root");
      try {
        const projectRoot = (await readFile(cachedProjectRootFile, "utf-8")).trim();
        if (projectRoot === cwd) return cachedProjectDir;
      } catch {
        // fall through to full scan
      }
      geminiProjectDirCache.delete(cacheKey);
    }

    try {
      const entries = await readdir(geminiTmpRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectDir = join(geminiTmpRoot, entry.name);
        const projectRootFile = join(projectDir, ".project_root");
        try {
          const projectRoot = (await readFile(projectRootFile, "utf-8")).trim();
          if (projectRoot === cwd) {
            geminiProjectDirCache.set(cacheKey, projectDir);
            return projectDir;
          }
        } catch {
          // skip unreadable project_root file
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  });
}

export async function parseGeminiSession(
  cwd: string,
  options: GeminiParseOptions = {},
): Promise<Partial<AgentSession> & { sessionFile?: string }> {
  return await profileAsync("gemini", "parseGeminiSession", async () => {
    const projectDir = await resolveGeminiProjectDir(cwd, options);
    if (!projectDir) return {};

    const chatsDir = join(projectDir, "chats");
    try {
      const files = (await readdir(chatsDir))
        .filter((name) => name.startsWith("session-") && name.endsWith(".json"))
        .map((name) => join(chatsDir, name));
      if (files.length === 0) return {};

      let latestFile: string | undefined;
      let latestMtimeMs = -1;
      for (const filePath of files) {
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs > latestMtimeMs) {
            latestMtimeMs = fileStat.mtimeMs;
            latestFile = filePath;
          }
        } catch {
          // skip unreadable file
        }
      }
      if (!latestFile) return {};

      const parsed = parseGeminiSessionContent(await readFile(latestFile, "utf-8"), options);
      return {
        cwd,
        sessionId: parsed.sessionId,
        startedAt: parsed.startedAt,
        lastActivityAt: parsed.lastActivityAt,
        lastResponseAt: parsed.lastResponseAt,
        tokenUsage: parsed.tokenUsage,
        model: parsed.model,
        phase: parsed.phase,
        sessionMatched: true,
        sessionFile: latestFile,
      };
    } catch {
      return {};
    }
  });
}

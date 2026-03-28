/**
 * Gemini session parsing and phase detection.
 */

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSession, SessionPhase, TokenUsage } from "../types.js";
import { HOME } from "./cache.js";

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

export function parseGeminiSessionContent(raw: string): Partial<GeminiSessionMeta> {
  try {
    const data = JSON.parse(raw);
    const messages = Array.isArray(data.messages) ? (data.messages as GeminiMessage[]) : [];
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
      model: latestGeminiMessage?.model,
      tokenUsage: latestGeminiMessage?.tokens
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

export async function resolveGeminiProjectDir(cwd: string): Promise<string | undefined> {
  const geminiTmpRoot = join(HOME, ".gemini", "tmp");
  if (!existsSync(geminiTmpRoot)) return undefined;

  try {
    const entries = await readdir(geminiTmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(geminiTmpRoot, entry.name);
      const projectRootFile = join(projectDir, ".project_root");
      if (!existsSync(projectRootFile)) continue;
      try {
        const projectRoot = (await readFile(projectRootFile, "utf-8")).trim();
        if (projectRoot === cwd) return projectDir;
      } catch {
        // skip unreadable project_root file
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function parseGeminiSession(
  cwd: string,
): Promise<Partial<AgentSession> & { sessionFile?: string }> {
  const projectDir = await resolveGeminiProjectDir(cwd);
  if (!projectDir) return {};

  const chatsDir = join(projectDir, "chats");
  if (!existsSync(chatsDir)) return {};

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

    const parsed = parseGeminiSessionContent(await readFile(latestFile, "utf-8"));
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
}

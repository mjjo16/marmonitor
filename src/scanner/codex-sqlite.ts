/**
 * Codex session indexing via SQLite threads table.
 * Uses sqlite3 CLI (pre-installed on macOS/Linux) — no npm dependency.
 * Falls back gracefully if sqlite3 is unavailable or DB is missing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexSessionMeta } from "./cache.js";

const execFileAsync = promisify(execFile);

/**
 * Query Codex state SQLite for active (non-archived) threads.
 * Returns CodexSessionMeta[] compatible with existing matchCodexSession().
 */
export async function indexCodexSessionsFromSqlite(dbPath: string): Promise<CodexSessionMeta[]> {
  try {
    const { stdout } = await execFileAsync("sqlite3", [
      dbPath,
      "-separator",
      "\t",
      "SELECT id, cwd, rollout_path, tokens_used, model, updated_at, created_at FROM threads WHERE archived = 0 ORDER BY updated_at DESC;",
    ]);

    const lines = stdout.trim().split("\n").filter(Boolean);
    const sessions: CodexSessionMeta[] = [];

    for (const line of lines) {
      const [id, cwd, rolloutPath, tokensUsed, model, updatedAt, createdAt] = line.split("\t");
      if (!id || !cwd) continue;

      sessions.push({
        filePath: rolloutPath ?? "",
        id,
        cwd,
        timestamp: Number(createdAt) || 0,
        lastActivityAt: Number(updatedAt) || undefined,
        totalTokenUsage: tokensUsed
          ? {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: Number(tokensUsed) || 0,
            }
          : undefined,
        model: model || undefined,
      });
    }

    return sessions;
  } catch {
    // sqlite3 not available, DB missing, or query failed — return empty
    return [];
  }
}

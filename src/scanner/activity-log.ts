/**
 * Activity log — extracts tool_use from Claude/Codex JSONL and writes daily logs.
 * Stored in ~/.config/marmonitor/activity-log/YYYY-MM-DD.jsonl
 */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ActivityEntry {
  ts: number;
  sid: string;
  agent: string;
  cwd: string;
  tool: string;
  target: string;
  tokens?: { in: number; out: number; cache: number };
}

export function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getRecentDateKeys(days: number, now = new Date()): string[] {
  const keys: string[] = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(now);
    date.setDate(now.getDate() - d);
    keys.push(formatDateKey(date));
  }
  return keys;
}

/** Extract tool_use entries from Claude Code JSONL lines */
export function extractClaudeToolUses(
  lines: string[],
  sessionId: string,
  agent: string,
  cwd: string,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.type !== "assistant") continue;

      const msg = d.message ?? {};
      const usage = msg.usage;
      const ts = parseTimestamp(d.timestamp);
      if (!ts) continue;

      const content = msg.content ?? [];
      for (const c of content) {
        if (c.type !== "tool_use") continue;

        const entry: ActivityEntry = {
          ts,
          sid: sessionId,
          agent,
          cwd,
          tool: c.name ?? "unknown",
          target: extractTarget(c.name, c.input ?? {}),
        };

        if (usage) {
          entry.tokens = {
            in: usage.input_tokens ?? 0,
            out: usage.output_tokens ?? 0,
            cache: usage.cache_read_input_tokens ?? 0,
          };
        }

        entries.push(entry);
      }
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

/** Extract tool events from Codex JSONL lines */
export function extractCodexToolUses(
  lines: string[],
  sessionId: string,
  agent: string,
  cwd: string,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let lastTokens: ActivityEntry["tokens"] | undefined;

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.type !== "event_msg") continue;

      const payload = d.payload ?? {};
      const ts = parseTimestamp(d.timestamp);

      if (payload.type === "token_count") {
        const last = payload.info?.last_token_usage;
        if (last) {
          lastTokens = {
            in: last.input_tokens ?? 0,
            out: last.output_tokens ?? 0,
            cache: last.cached_input_tokens ?? 0,
          };
        }
        continue;
      }

      if (!ts) continue;

      if (payload.type === "exec_command_end") {
        const cmd = Array.isArray(payload.command) ? payload.command.slice(-1)[0] : "";
        entries.push({
          ts,
          sid: sessionId,
          agent,
          cwd: payload.cwd ?? cwd,
          tool: "Bash",
          target: cmd.split("\n")[0].slice(0, 100),
          ...(lastTokens ? { tokens: lastTokens } : {}),
        });
        lastTokens = undefined;
      } else if (payload.type === "patch_apply_end") {
        const stdout = payload.stdout ?? "";
        const fileMatch = stdout.match(/[MA]\s+(.+)/);
        const target = fileMatch ? fileMatch[1].trim() : "unknown";
        entries.push({
          ts,
          sid: sessionId,
          agent,
          cwd,
          tool: "Edit",
          target: target.slice(0, 100),
          ...(lastTokens ? { tokens: lastTokens } : {}),
        });
        lastTokens = undefined;
      } else if (payload.type === "web_search_end") {
        entries.push({
          ts,
          sid: sessionId,
          agent,
          cwd,
          tool: "WebSearch",
          target: (payload.query ?? "").slice(0, 100),
          ...(lastTokens ? { tokens: lastTokens } : {}),
        });
        lastTokens = undefined;
      }
    } catch {
      // skip malformed lines
    }
  }

  return entries;
}

/** Append activity entries to daily log file */
export async function appendActivityEntries(
  logDir: string,
  dateStr: string,
  entries: ActivityEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(logDir, { recursive: true });
  const filePath = join(logDir, `${dateStr}.jsonl`);
  const data = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

  try {
    const existing = await readFile(filePath, "utf-8");
    await writeFile(filePath, existing + data, "utf-8");
  } catch {
    await writeFile(filePath, data, "utf-8");
  }
}

/** Read activity log for a specific date */
export async function readActivityLog(logDir: string, dateStr: string): Promise<ActivityEntry[]> {
  try {
    const raw = await readFile(join(logDir, `${dateStr}.jsonl`), "utf-8");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Delete activity logs older than retentionDays */
export async function cleanupOldActivityLogs(
  logDir: string,
  retentionDays: number,
  now = new Date(),
): Promise<number> {
  // Use start-of-day to avoid deleting today's cutoff date file early
  const cutoffDate = new Date(now.getTime() - retentionDays * 86400000);
  const cutoff = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate());
  const cutoffKey = formatDateKey(cutoff);
  let deleted = 0;

  try {
    const files = await readdir(logDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const dateStr = file.replace(".jsonl", "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;
      if (dateStr < cutoffKey) {
        await unlink(join(logDir, file));
        deleted++;
      }
    }
  } catch {
    // directory missing — nothing to clean
  }

  return deleted;
}

// ─── Helpers ─────────────────────────────────────────────────

function parseTimestamp(ts: unknown): number | undefined {
  if (typeof ts === "number") return Math.floor(ts);
  if (typeof ts === "string") {
    try {
      return Math.floor(new Date(ts).getTime() / 1000);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractTarget(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    return String(input.file_path ?? "unknown").slice(0, 100);
  }
  if (toolName === "Bash") {
    return String(input.command ?? "")
      .split("\n")[0]
      .slice(0, 100);
  }
  if (toolName === "Grep") {
    return String(input.pattern ?? "").slice(0, 50);
  }
  if (toolName === "Agent") {
    return String(input.description ?? "").slice(0, 50);
  }
  if (toolName === "Skill") {
    return String(input.skill ?? "");
  }
  if (toolName === "Glob") {
    return String(input.pattern ?? "");
  }
  return toolName;
}

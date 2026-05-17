/**
 * AI session turn parsing.
 *
 * Reads agent-local turn data (Claude jsonl for v1) and groups it into
 * user / assistant turns. A single assistant turn bundles all `text` /
 * `tool_use` / `tool_result` lines that follow a user prompt until the
 * next user prompt or `stop_reason === "end_turn"`.
 *
 * Two extraction modes are exposed via `TurnTextMode`:
 *   - "text" (default): assistant text blocks only. What the user saw
 *     Claude "say" — ideal for sharing to Slack / issue / note.
 *   - "bundle": text + tool_use input + tool_result content (thinking
 *     excluded). Closer to the full Claude UI rendering — for handing
 *     context to another AI or debug PRs.
 */

export type TurnRole = "user" | "assistant";
export type TurnTextMode = "text" | "bundle";

export interface SessionTurn {
  role: TurnRole;
  startedAt?: number; // epoch seconds
  completedAt?: number; // epoch seconds
  /** Assistant text-only extraction. user turns reuse this field. */
  text: string;
  /** Full bundle (text + tool_use + tool_result) — assistant turns only. */
  bundle?: string;
}

function toEpochSec(timestamp: unknown): number | undefined {
  if (typeof timestamp !== "string") return undefined;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

function formatToolInput(input: unknown): string {
  if (typeof input === "string") return input.trim();
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function formatToolResult(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content.trim();
  if (Array.isArray(item.content)) {
    return item.content
      .map((child) => {
        if (!child || typeof child !== "object") return String(child);
        const c = child as Record<string, unknown>;
        if (typeof c.text === "string") return c.text.trim();
        return JSON.stringify(c);
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** Extract assistant text-only parts from a Claude assistant message. */
function extractAssistantText(content: unknown): string[] {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? [t] : [];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (c): c is Record<string, unknown> =>
        Boolean(c) && typeof c === "object" && (c as Record<string, unknown>).type === "text",
    )
    .map((c) => (typeof c.text === "string" ? c.text.trim() : ""))
    .filter(Boolean);
}

/** Extract bundle parts (text + tool_use + tool_result) — thinking excluded. */
function extractAssistantBundle(content: unknown): string[] {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? [t] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    switch (block.type) {
      case "text": {
        const t = typeof block.text === "string" ? block.text.trim() : "";
        if (t) parts.push(t);
        break;
      }
      case "tool_use": {
        const name = typeof block.name === "string" ? block.name : "unknown";
        parts.push(`[tool_use:${name}]\n${formatToolInput(block.input)}`);
        break;
      }
      case "tool_result": {
        const body = formatToolResult(block);
        if (body) parts.push(`[tool_result]\n${body}`);
        break;
      }
      // "thinking" intentionally excluded
    }
  }
  return parts;
}

/** Parse Claude user message — `tool_result`-only blocks are not real user prompts. */
function parseClaudeUserMessage(
  content: unknown,
): { text: string; isToolResult: boolean } | undefined {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? { text: t, isToolResult: false } : undefined;
  }
  if (!Array.isArray(content)) return undefined;

  const blockTypes = content
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).type : undefined))
    .filter((t): t is string => typeof t === "string");
  const onlyToolResult = blockTypes.length > 0 && blockTypes.every((t) => t === "tool_result");

  // Only emit prompt text for genuine user prompts.
  const textParts = content
    .filter(
      (c): c is Record<string, unknown> =>
        Boolean(c) && typeof c === "object" && (c as Record<string, unknown>).type === "text",
    )
    .map((c) => (typeof c.text === "string" ? c.text.trim() : ""))
    .filter(Boolean);

  if (onlyToolResult) {
    // bundle 모드에서 합쳐질 수 있도록 raw content를 살리되 prompt로는 안 셈
    return { text: "", isToolResult: true };
  }
  return textParts.length > 0 ? { text: textParts.join("\n\n"), isToolResult: false } : undefined;
}

interface PendingAssistant {
  texts: string[];
  bundleParts: string[];
  startedAt?: number;
  completedAt?: number;
}

function flushAssistant(turns: SessionTurn[], pending: PendingAssistant): void {
  const text = pending.texts.join("\n\n").trim();
  const bundle = pending.bundleParts.join("\n\n").trim();
  if (!text && !bundle) return;
  turns.push({
    role: "assistant",
    startedAt: pending.startedAt,
    completedAt: pending.completedAt ?? pending.startedAt,
    text,
    bundle: bundle || undefined,
  });
}

function newPending(): PendingAssistant {
  return { texts: [], bundleParts: [], startedAt: undefined, completedAt: undefined };
}

/**
 * Parse a Claude session JSONL into ordered user/assistant turns.
 * Lines without role information (file-history-snapshot, last-prompt, etc.)
 * are ignored.
 */
export function parseClaudeConversationTurns(raw: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let pending = newPending();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = typeof entry.type === "string" ? entry.type : undefined;
    if (entryType !== "user" && entryType !== "assistant") continue;

    const message =
      entry.message && typeof entry.message === "object"
        ? (entry.message as Record<string, unknown>)
        : undefined;
    const ts = toEpochSec(entry.timestamp);

    if (entryType === "user") {
      const parsed = parseClaudeUserMessage(message?.content);
      if (!parsed) continue;

      if (parsed.isToolResult) {
        // tool_result는 진행 중인 assistant turn에 묶음으로 합쳐짐
        if (pending.bundleParts.length > 0 || pending.texts.length > 0) {
          const body = formatToolResult(
            // 다시 추출 — bundle 형태로
            { content: (message?.content as unknown) ?? [] },
          );
          if (body) pending.bundleParts.push(`[tool_result]\n${body}`);
          if (ts !== undefined) pending.completedAt = ts;
        }
        continue;
      }

      flushAssistant(turns, pending);
      pending = newPending();
      turns.push({ role: "user", startedAt: ts, completedAt: ts, text: parsed.text });
      continue;
    }

    // assistant
    const texts = extractAssistantText(message?.content);
    const bundleParts = extractAssistantBundle(message?.content);
    if (texts.length === 0 && bundleParts.length === 0) continue;

    if (pending.startedAt === undefined) pending.startedAt = ts;
    if (ts !== undefined) pending.completedAt = ts;
    pending.texts.push(...texts);
    pending.bundleParts.push(...bundleParts);

    if (message?.stop_reason === "end_turn") {
      flushAssistant(turns, pending);
      pending = newPending();
    }
  }

  flushAssistant(turns, pending);
  return turns;
}

/** Pick the latest turn for a given role. */
export function selectLatestTurn(
  turns: SessionTurn[],
  role: TurnRole = "assistant",
): SessionTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === role) return turns[i];
  }
  return undefined;
}

/** Extract the copyable text from a turn for the chosen mode. */
export function turnTextForMode(turn: SessionTurn, mode: TurnTextMode = "text"): string {
  if (mode === "bundle" && turn.bundle) return turn.bundle;
  return turn.text;
}

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
    // Keep the raw content for bundle mode, but do not count it as a user prompt.
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
        // tool_result entries merge into the in-progress assistant turn.
        if (pending.bundleParts.length > 0 || pending.texts.length > 0) {
          const body = formatToolResult(
            // Re-extract the raw content into bundle form.
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

/* ─── Codex rollout JSONL parser ─────────────────────────────────────── */

function extractCodexMessageTexts(content: unknown): string[] {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? [t] : [];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
    .map((c) => {
      const t = (c as Record<string, unknown>).type;
      // Both input_text (user/developer) and output_text (assistant) carry plain text.
      if (t === "input_text" || t === "output_text") {
        const text = (c as Record<string, unknown>).text;
        return typeof text === "string" ? text.trim() : "";
      }
      return "";
    })
    .filter(Boolean);
}

function formatCodexFunctionCall(payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" ? payload.name : "unknown";
  const args = typeof payload.arguments === "string" ? payload.arguments : "";
  // arguments is a stringified JSON — try to pretty-print.
  let pretty = args;
  try {
    pretty = JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    // keep as-is if not valid JSON
  }
  return `[function_call:${name}]\n${pretty}`.trim();
}

function formatCodexFunctionOutput(payload: Record<string, unknown>): string {
  const output = typeof payload.output === "string" ? payload.output.trim() : "";
  if (!output) return "";
  return `[function_call_output]\n${output}`;
}

/**
 * Parse a Codex rollout JSONL into ordered user/assistant turns.
 *
 * Rollout structure:
 *   - `type: "session_meta"` / `"event_msg"` / `"turn_context"` — meta, ignored
 *   - `type: "response_item"` payload:
 *       - `type: "message"` + `role: "user"|"assistant"|"developer"`
 *           — content is an array of `{type: "input_text"|"output_text", text}`.
 *           `developer` is system-side, skipped.
 *       - `type: "reasoning"` — Codex's thinking, excluded (matches option B).
 *       - `type: "function_call"` — tool invocation (bundle-only).
 *       - `type: "function_call_output"` — tool result (bundle-only).
 *       - `type: "web_search_call"` — surfaced as a marker in bundle.
 *
 * Turn boundary: a new `user` message flushes the in-progress assistant.
 */
export function parseCodexConversationTurns(raw: string): SessionTurn[] {
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
    if (entry.type !== "response_item") continue;

    const payload =
      entry.payload && typeof entry.payload === "object"
        ? (entry.payload as Record<string, unknown>)
        : undefined;
    if (!payload) continue;

    const ts = toEpochSec(entry.timestamp);
    const ptype = typeof payload.type === "string" ? payload.type : "";

    if (ptype === "message") {
      const role = typeof payload.role === "string" ? payload.role : "";
      // Developer messages are system-side scaffolding — skip.
      if (role === "developer") continue;

      const texts = extractCodexMessageTexts(payload.content);
      if (texts.length === 0) continue;

      if (role === "user") {
        flushAssistant(turns, pending);
        pending = newPending();
        const text = texts.join("\n\n").trim();
        if (text) turns.push({ role: "user", startedAt: ts, completedAt: ts, text });
        continue;
      }
      if (role === "assistant") {
        if (pending.startedAt === undefined) pending.startedAt = ts;
        if (ts !== undefined) pending.completedAt = ts;
        pending.texts.push(...texts);
        pending.bundleParts.push(...texts);
        continue;
      }
      continue;
    }

    if (ptype === "function_call") {
      const piece = formatCodexFunctionCall(payload);
      if (piece) pending.bundleParts.push(piece);
      if (ts !== undefined) pending.completedAt = ts;
      continue;
    }

    if (ptype === "function_call_output") {
      const piece = formatCodexFunctionOutput(payload);
      if (piece) pending.bundleParts.push(piece);
      if (ts !== undefined) pending.completedAt = ts;
      continue;
    }

    if (ptype === "web_search_call") {
      pending.bundleParts.push("[web_search_call]");
      if (ts !== undefined) pending.completedAt = ts;
    }

    // "reasoning" intentionally excluded (option B).
  }

  flushAssistant(turns, pending);
  return turns;
}

/* ─── Gemini chats JSON parser ───────────────────────────────────────── */

interface GeminiMessage {
  type?: unknown;
  content?: unknown;
  timestamp?: unknown;
  parts?: unknown;
}

function extractGeminiText(msg: GeminiMessage): string {
  if (typeof msg.content === "string") return msg.content.trim();
  // Some Gemini variants store rich content under `parts: [{ text } | { functionCall } ...]`.
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const obj = p as Record<string, unknown>;
        if (typeof obj.text === "string") return obj.text.trim();
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/**
 * Parse a Gemini chats JSON (`messages: [{type, content, timestamp, ...}]`)
 * into ordered user/assistant turns.
 *
 * Recognised message types:
 *   - `"user"`        — user prompt → user turn
 *   - `"gemini"`      — assistant response → flushed as assistant turn
 *   - everything else (`"info"`, `"error"`, etc.) — ignored as scaffolding
 *
 * NOTE: live verification is currently unavailable (the user does not run the
 * Gemini CLI). Behaviour is covered by unit tests with fixture data and is
 * expected to be conservative — unknown shapes degrade to no-turn rather than
 * raising.
 */
export function parseGeminiConversationTurns(raw: string): SessionTurn[] {
  let data: { messages?: unknown };
  try {
    data = JSON.parse(raw) as { messages?: unknown };
  } catch {
    return [];
  }
  if (!data || !Array.isArray(data.messages)) return [];

  const turns: SessionTurn[] = [];
  let pending = newPending();

  for (const m of data.messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as GeminiMessage;
    const ts = toEpochSec(msg.timestamp);
    const type = typeof msg.type === "string" ? msg.type : "";
    const text = extractGeminiText(msg);

    if (type === "user") {
      flushAssistant(turns, pending);
      pending = newPending();
      if (text) turns.push({ role: "user", startedAt: ts, completedAt: ts, text });
      continue;
    }
    if (type === "gemini") {
      if (!text) continue;
      if (pending.startedAt === undefined) pending.startedAt = ts;
      if (ts !== undefined) pending.completedAt = ts;
      pending.texts.push(text);
      // `bundleParts` intentionally untouched: Gemini chats JSON does not
      // expose tool-call / tool-result as separately addressable blocks the
      // way Claude/Codex jsonl does. Producing a "bundle" that's identical
      // to `text` would be a dishonest no-op, so we leave `turn.bundle`
      // undefined and let `turnTextForMode(turn, 'bundle')` fall back to
      // `turn.text` (the documented degradation path).
    }
    // info / error / unknown — skip
  }

  flushAssistant(turns, pending);
  return turns;
}

/* ────────────────────────────────────────────────────────────────────── */

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

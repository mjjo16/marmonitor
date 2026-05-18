import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseClaudeConversationTurns,
  parseCodexConversationTurns,
  parseGeminiConversationTurns,
  selectLatestTurn,
  turnTextForMode,
} from "../dist/turns.js";

function jsonl(...lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

function codexLine(payload, ts = "2026-05-18T01:00:00.000Z") {
  return JSON.stringify({ timestamp: ts, type: "response_item", payload });
}

describe("parseClaudeConversationTurns — user turn", () => {
  it("extracts a single user prompt with text content array", () => {
    const raw = jsonl({
      type: "user",
      timestamp: "2026-05-17T01:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello claude" }],
      },
    });
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "hello claude");
  });

  it("supports string content (legacy form)", () => {
    const raw = jsonl({
      type: "user",
      timestamp: "2026-05-17T01:00:00.000Z",
      message: { role: "user", content: "raw string prompt" },
    });
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, "raw string prompt");
  });
});

describe("parseClaudeConversationTurns — assistant turn grouping", () => {
  it("groups thinking + text + tool_use + tool_result + post-text into a single assistant turn", () => {
    const raw = jsonl(
      // user prompt
      {
        type: "user",
        timestamp: "2026-05-17T01:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "list files" }] },
      },
      // assistant thinking (옵션 B에서는 빠짐)
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:01.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "thinking", text: "내가 ls를 호출해야지" }],
        },
      },
      // assistant text
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:02.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "파일 목록을 확인할게요." }],
        },
      },
      // assistant tool_use
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:03.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
        },
      },
      // user tool_result
      {
        type: "user",
        timestamp: "2026-05-17T01:00:04.000Z",
        message: { role: "user", content: [{ type: "tool_result", content: "file1\nfile2" }] },
      },
      // assistant final answer (end_turn)
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:05.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "두 파일이 있습니다." }],
        },
      },
    );
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 2, "한 user + 한 assistant turn으로 묶임");

    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "list files");

    assert.equal(turns[1].role, "assistant");
    // 옵션 B: text만 — thinking 빠지고 text 라인 두 개만
    assert.match(turns[1].text, /파일 목록을 확인할게요/);
    assert.match(turns[1].text, /두 파일이 있습니다/);
    assert.doesNotMatch(turns[1].text, /tool_use/);
    assert.doesNotMatch(turns[1].text, /tool_result/);
    assert.doesNotMatch(turns[1].text, /ls를 호출/);

    // 옵션 A: bundle — text + tool_use + tool_result
    const bundle = turns[1].bundle ?? "";
    assert.match(bundle, /\[tool_use:Bash\]/);
    assert.match(bundle, /ls -la/);
    assert.match(bundle, /\[tool_result\]/);
    assert.match(bundle, /file1/);
    assert.doesNotMatch(bundle, /ls를 호출/); // thinking 여전히 제외
  });

  it("separates later user prompts from previous assistant turn", () => {
    const raw = jsonl(
      {
        type: "user",
        timestamp: "2026-05-17T01:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "첫 요청" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:01.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "첫 답변" }],
        },
      },
      {
        type: "user",
        timestamp: "2026-05-17T01:00:02.000Z",
        message: { role: "user", content: [{ type: "text", text: "둘째 요청" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:03.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "둘째 답변" }],
        },
      },
    );
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 4);
    assert.equal(turns[2].text, "둘째 요청");
    assert.equal(turns[3].text, "둘째 답변");
  });

  it("flushes an in-progress assistant turn without end_turn at EOF", () => {
    const raw = jsonl(
      {
        type: "user",
        timestamp: "2026-05-17T01:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "ping" }] },
      },
      // stop_reason 없음, end_turn 안 옴 — flush at EOF
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:01.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "진행 중..." }],
        },
      },
    );
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].role, "assistant");
    assert.equal(turns[1].text, "진행 중...");
  });

  it("joins multiple text lines with double newline", () => {
    const raw = jsonl(
      {
        type: "user",
        timestamp: "2026-05-17T01:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "q" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:01.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "첫 줄" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:02.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "둘째 줄" }],
        },
      },
    );
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns[1].text, "첫 줄\n\n둘째 줄");
  });
});

describe("parseClaudeConversationTurns — robustness", () => {
  it("ignores meta types (system, file-history-snapshot, last-prompt, ...)", () => {
    const raw = jsonl(
      { type: "system", message: { content: "system info" } },
      { type: "file-history-snapshot", snapshot: { timestamp: "2026-05-17T01:00:00.000Z" } },
      { type: "last-prompt", content: "..." },
      { type: "permission-mode", permissionMode: "default" },
      {
        type: "user",
        timestamp: "2026-05-17T01:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-05-17T01:00:02.000Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello" }],
        },
      },
      { type: "ai-title", content: "..." },
    );
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, "hi");
    assert.equal(turns[1].text, "hello");
  });

  it("skips malformed JSON lines", () => {
    const raw = [
      "not json",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "ok" }] },
      }),
      "{ broken",
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "fine" }],
        },
      }),
    ].join("\n");
    const turns = parseClaudeConversationTurns(raw);
    assert.equal(turns.length, 2);
  });

  it("returns empty array on empty input", () => {
    assert.deepEqual(parseClaudeConversationTurns(""), []);
    assert.deepEqual(parseClaudeConversationTurns("\n\n\n"), []);
  });

  it("returns empty array when there is no user/assistant content", () => {
    const raw = jsonl({ type: "system" }, { type: "file-history-snapshot" });
    assert.deepEqual(parseClaudeConversationTurns(raw), []);
  });
});

describe("selectLatestTurn", () => {
  const turns = [
    { role: "user", text: "u1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "u2" },
    { role: "assistant", text: "a2" },
  ];

  it("returns the latest assistant by default", () => {
    assert.equal(selectLatestTurn(turns)?.text, "a2");
  });

  it("filters by role=user", () => {
    assert.equal(selectLatestTurn(turns, "user")?.text, "u2");
  });

  it("returns undefined when no matching role exists", () => {
    assert.equal(selectLatestTurn([{ role: "user", text: "only" }], "assistant"), undefined);
  });
});

describe("turnTextForMode", () => {
  const turn = {
    role: "assistant",
    text: "답변 텍스트",
    bundle: "답변 텍스트\n\n[tool_use:Bash]\nls",
  };

  it("returns text-only by default", () => {
    assert.equal(turnTextForMode(turn), "답변 텍스트");
  });

  it("returns bundle when mode='bundle'", () => {
    assert.match(turnTextForMode(turn, "bundle"), /\[tool_use:Bash\]/);
  });

  it("falls back to text when bundle is missing", () => {
    const t = { role: "user", text: "u1" };
    assert.equal(turnTextForMode(t, "bundle"), "u1");
  });
});

describe("parseCodexConversationTurns", () => {
  it("groups user message + assistant message + tool cycle into a single assistant turn", () => {
    const raw = [
      codexLine({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "find files" }],
      }),
      codexLine({
        type: "reasoning",
        summary: ["thinking..."],
        content: null,
      }),
      codexLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "파일을 찾아볼게요." }],
      }),
      codexLine({
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"rg foo","workdir":"/tmp"}',
        call_id: "call_1",
      }),
      codexLine({
        type: "function_call_output",
        call_id: "call_1",
        output: "match1\nmatch2",
      }),
      codexLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "두 개 찾았습니다." }],
      }),
    ].join("\n");

    const turns = parseCodexConversationTurns(raw);
    assert.equal(turns.length, 2);

    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "find files");

    assert.equal(turns[1].role, "assistant");
    // option B (text-only): reasoning + function_call + function_call_output 제외
    assert.match(turns[1].text, /파일을 찾아볼게요/);
    assert.match(turns[1].text, /두 개 찾았습니다/);
    assert.doesNotMatch(turns[1].text, /function_call/);
    assert.doesNotMatch(turns[1].text, /thinking/);

    // bundle: text + function_call(arguments pretty) + function_call_output
    const bundle = turns[1].bundle ?? "";
    assert.match(bundle, /\[function_call:exec_command\]/);
    assert.match(bundle, /"cmd": "rg foo"/);
    assert.match(bundle, /\[function_call_output\]/);
    assert.match(bundle, /match1/);
    assert.doesNotMatch(bundle, /thinking/); // reasoning은 여전히 제외
  });

  it("separates later user messages from previous assistant turn", () => {
    const raw = [
      codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] }),
      codexLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "a1" }],
      }),
      codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] }),
      codexLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "a2" }],
      }),
    ].join("\n");

    const turns = parseCodexConversationTurns(raw);
    assert.equal(turns.length, 4);
    assert.equal(turns[2].text, "q2");
    assert.equal(turns[3].text, "a2");
  });

  it("skips developer messages and unknown response_item types gracefully", () => {
    const raw = [
      codexLine({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system instruction" }],
      }),
      codexLine({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      }),
      codexLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      }),
      codexLine({ type: "web_search_call", payload_extra: "..." }),
      codexLine({ type: "unknown_future_type" }),
    ].join("\n");

    const turns = parseCodexConversationTurns(raw);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, "hi");
    assert.equal(turns[1].text, "hello");
    assert.match(turns[1].bundle ?? "", /\[web_search_call\]/);
  });

  it("ignores non-response_item lines (session_meta, event_msg, turn_context)", () => {
    const raw = [
      JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
      JSON.stringify({ type: "event_msg", payload: { kind: "..." } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "t1" } }),
      codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: "ok" }] }),
      codexLine({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "fine" }],
      }),
    ].join("\n");

    const turns = parseCodexConversationTurns(raw);
    assert.equal(turns.length, 2);
  });

  it("returns empty array on empty input or malformed JSON", () => {
    assert.deepEqual(parseCodexConversationTurns(""), []);
    assert.deepEqual(parseCodexConversationTurns("not json\n{ broken"), []);
  });
});

describe("parseGeminiConversationTurns", () => {
  it("groups type:user + type:gemini into ordered turns", () => {
    const raw = JSON.stringify({
      messages: [
        { type: "info", content: "auth ok", timestamp: "2026-04-07T01:21:00.000Z" },
        { type: "user", content: "안녕", timestamp: "2026-04-07T01:22:00.000Z" },
        { type: "gemini", content: "반가워요!", timestamp: "2026-04-07T01:22:01.000Z" },
        { type: "user", content: "고마워", timestamp: "2026-04-07T01:23:00.000Z" },
        { type: "gemini", content: "별말씀을요.", timestamp: "2026-04-07T01:23:01.000Z" },
      ],
    });

    const turns = parseGeminiConversationTurns(raw);
    assert.equal(turns.length, 4);
    assert.equal(turns[0].role, "user");
    assert.equal(turns[0].text, "안녕");
    assert.equal(turns[1].role, "assistant");
    assert.equal(turns[1].text, "반가워요!");
    assert.equal(turns[3].text, "별말씀을요.");
  });

  it("skips info/error/unknown message types", () => {
    const raw = JSON.stringify({
      messages: [
        { type: "info", content: "..." },
        { type: "error", content: "..." },
        { type: "tool", content: "..." },
        { type: "user", content: "hi" },
        { type: "gemini", content: "hello" },
      ],
    });
    const turns = parseGeminiConversationTurns(raw);
    assert.equal(turns.length, 2);
  });

  it("falls back to parts[].text when content is missing", () => {
    const raw = JSON.stringify({
      messages: [
        { type: "user", parts: [{ text: "from parts" }] },
        { type: "gemini", parts: [{ text: "first part" }, { text: "second part" }] },
      ],
    });
    const turns = parseGeminiConversationTurns(raw);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, "from parts");
    assert.equal(turns[1].text, "first part\n\nsecond part");
  });

  it("returns empty array on malformed JSON or missing messages", () => {
    assert.deepEqual(parseGeminiConversationTurns(""), []);
    assert.deepEqual(parseGeminiConversationTurns("not json"), []);
    assert.deepEqual(parseGeminiConversationTurns("{}"), []);
    assert.deepEqual(parseGeminiConversationTurns(JSON.stringify({ messages: null })), []);
  });
});

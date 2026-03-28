import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { setCodexIndexCache } from "../dist/scanner/cache.js";
import { indexCodexSessions } from "../dist/scanner/codex.js";
import {
  detectAgentFromProcessSignature,
  parseGeminiSessionContent,
  propagateWorkerStateToParent,
} from "../dist/scanner/index.js";

describe("detectAgentFromProcessSignature", () => {
  const config = getDefaults();

  it("matches native binary names directly", () => {
    assert.equal(
      detectAgentFromProcessSignature({ name: "claude", cmd: "/usr/local/bin/claude" }, config),
      "Claude Code",
    );
  });

  it("matches node-based CLIs using command path fallback", () => {
    assert.equal(
      detectAgentFromProcessSignature(
        { name: "node", cmd: "/opt/homebrew/bin/gemini chat --prompt hi" },
        config,
      ),
      "Gemini",
    );
    assert.equal(
      detectAgentFromProcessSignature(
        { name: "node", cmd: "/Users/me/.npm/bin/codex --approval-mode auto" },
        config,
      ),
      "Codex",
    );
  });

  it("does not falsely match unrelated node processes", () => {
    assert.equal(
      detectAgentFromProcessSignature(
        { name: "node", cmd: "/Users/me/project/node_modules/.bin/webpack-dev-server" },
        config,
      ),
      null,
    );
    assert.equal(
      detectAgentFromProcessSignature(
        { name: "node", cmd: "/some/path/gemini-other-tool --watch" },
        config,
      ),
      null,
    );
  });
});

describe("parseGeminiSessionContent", () => {
  it("extracts started/last activity/response/model/tokens from Gemini chat JSON", () => {
    const parsed = parseGeminiSessionContent(
      JSON.stringify({
        sessionId: "abc-123",
        startTime: "2026-03-28T10:38:11.868Z",
        lastUpdated: "2026-03-28T10:52:01.392Z",
        messages: [
          {
            timestamp: "2026-03-28T10:38:11.868Z",
            type: "user",
          },
          {
            timestamp: "2026-03-28T10:38:15.504Z",
            type: "gemini",
            model: "gemini-3-flash-preview",
            tokens: { input: 9426, output: 26, cached: 0, total: 9596 },
          },
        ],
      }),
    );

    assert.equal(parsed.sessionId, "abc-123");
    assert.equal(parsed.startedAt, new Date("2026-03-28T10:38:11.868Z").getTime() / 1000);
    assert.equal(parsed.lastActivityAt, new Date("2026-03-28T10:52:01.392Z").getTime() / 1000);
    assert.equal(parsed.lastResponseAt, new Date("2026-03-28T10:38:15.504Z").getTime() / 1000);
    assert.equal(parsed.model, "gemini-3-flash-preview");
    assert.deepEqual(parsed.tokenUsage, {
      inputTokens: 9426,
      outputTokens: 26,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 9596,
    });
    assert.equal(parsed.phase, "done");
  });

  it("marks a user-last session as thinking", () => {
    const parsed = parseGeminiSessionContent(
      JSON.stringify({
        sessionId: "abc-123",
        startTime: "2026-03-28T10:38:11.868Z",
        messages: [
          { timestamp: "2026-03-28T10:38:11.868Z", type: "user" },
          { timestamp: "2026-03-28T10:38:12.868Z", type: "gemini" },
          { timestamp: "2026-03-28T10:40:00.000Z", type: "user" },
        ],
      }),
    );

    assert.equal(parsed.phase, "thinking");
  });

  it("returns empty data for malformed Gemini session content", () => {
    assert.deepEqual(parseGeminiSessionContent("{invalid"), {});
  });
});

describe("propagateWorkerStateToParent", () => {
  it("promotes a stalled parent to active using worker cpu/memory/activity", () => {
    const parent = {
      agentName: "Codex",
      pid: 77447,
      cwd: "/tmp/project",
      cpuPercent: 0,
      memoryMb: 24,
      status: "Stalled",
      phase: "permission",
      startedAt: 1_700_000_000,
      lastActivityAt: 1_700_000_100,
    };

    const child = {
      status: "Active",
      phase: "tool",
      cpuPercent: 1.1,
      memoryMb: 205,
      startedAt: 1_700_000_050,
      lastActivityAt: 1_700_000_400,
      lastResponseAt: 1_700_000_350,
    };

    const propagated = propagateWorkerStateToParent(parent, child);
    assert.equal(propagated.status, "Active");
    assert.equal(propagated.phase, "tool");
    assert.equal(propagated.cpuPercent, 1.1);
    assert.equal(propagated.memoryMb, 229);
    assert.equal(propagated.startedAt, 1_700_000_000);
    assert.equal(propagated.lastActivityAt, 1_700_000_400);
    assert.equal(propagated.lastResponseAt, 1_700_000_350);
  });

  it("inherits permission phase from an active worker when available", () => {
    const propagated = propagateWorkerStateToParent(
      {
        agentName: "Gemini",
        pid: 1,
        cwd: "/tmp/project",
        cpuPercent: 0,
        memoryMb: 58,
        status: "Idle",
        phase: undefined,
      },
      {
        status: "Active",
        phase: "permission",
        cpuPercent: 0.5,
        memoryMb: 200,
      },
    );

    assert.equal(propagated.status, "Active");
    assert.equal(propagated.phase, "permission");
    assert.equal(propagated.cpuPercent, 0.5);
    assert.equal(propagated.memoryMb, 258);
  });

  it("does not change the parent when the worker is not active", () => {
    const parent = {
      agentName: "Codex",
      pid: 2,
      cwd: "/tmp/project",
      cpuPercent: 0,
      memoryMb: 20,
      status: "Stalled",
      phase: "permission",
    };

    assert.deepEqual(
      propagateWorkerStateToParent(parent, {
        status: "Idle",
        phase: "tool",
        cpuPercent: 0.3,
        memoryMb: 100,
      }),
      parent,
    );
  });
});

describe("indexCodexSessions", () => {
  it("records lastActivityAt from the session file mtime", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const root = join(tmpdir(), `marmonitor-codex-index-${Date.now()}`);
    const dayDir = join(root, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, "session.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "codex-1",
            cwd: "/tmp/project",
            timestamp: new Date("2026-03-28T10:00:00.000Z").toISOString(),
            model_provider: "gpt-5.4",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
                total_tokens: 15,
              },
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    setCodexIndexCache(undefined);
    const config = getDefaults();
    config.paths.codexSessions = [root];
    const sessions = await indexCodexSessions(config);
    const matched = sessions.find((item) => item.filePath === filePath);

    assert.ok(matched);
    assert.ok(matched.lastActivityAt);
    assert.ok(Math.abs(matched.lastActivityAt - Date.now() / 1000) < 10);
  });
});

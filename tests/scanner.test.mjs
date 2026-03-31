import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import {
  codexIndexCache,
  geminiProjectDirCache,
  setCodexIndexCache,
} from "../dist/scanner/cache.js";
import { parseClaudeSession } from "../dist/scanner/claude.js";
import { indexCodexSessions } from "../dist/scanner/codex.js";
import { resolveGeminiProjectDir } from "../dist/scanner/gemini.js";
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

  it("handles null/undefined items in messages array without crashing", () => {
    const parsed = parseGeminiSessionContent(
      JSON.stringify({
        messages: [null, undefined, { type: "user", timestamp: "2026-03-28T10:00:00Z" }],
      }),
    );
    assert.equal(parsed.phase, "thinking");
  });

  it("handles message with missing fields gracefully", () => {
    const parsed = parseGeminiSessionContent(
      JSON.stringify({ messages: [{ type: "gemini" }, {}] }),
    );
    assert.ok(parsed.phase === "done" || parsed.phase === undefined);
  });

  it("can skip token extraction in light mode", () => {
    const parsed = parseGeminiSessionContent(
      JSON.stringify({
        sessionId: "abc-123",
        startTime: "2026-03-28T10:38:11.868Z",
        messages: [
          {
            timestamp: "2026-03-28T10:38:15.504Z",
            type: "gemini",
            model: "gemini-3-flash-preview",
            tokens: { input: 9426, output: 26, cached: 0, total: 9596 },
          },
        ],
      }),
      { includeTokenUsage: false },
    );

    assert.equal(parsed.model, undefined);
    assert.equal(parsed.tokenUsage, undefined);
    assert.equal(parsed.phase, "done");
  });
});

describe("resolveGeminiProjectDir", () => {
  it("caches a matching Gemini project directory", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "marmonitor-gemini-cache-"));
    const projectDir = join(tmpRoot, "project-a");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".project_root"), "/repo/gemini-cache\n", "utf8");

    geminiProjectDirCache.clear();
    const resolved = await resolveGeminiProjectDir("/repo/gemini-cache", { tmpRoot });

    assert.equal(resolved, projectDir);
    assert.equal(geminiProjectDirCache.get(`${tmpRoot}::/repo/gemini-cache`), projectDir);
  });

  it("invalidates a stale Gemini project-dir cache entry and finds the new match", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "marmonitor-gemini-stale-"));
    const staleDir = join(tmpRoot, "project-stale");
    const freshDir = join(tmpRoot, "project-fresh");
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, ".project_root"), "/repo/gemini-stale\n", "utf8");

    geminiProjectDirCache.clear();
    const firstResolved = await resolveGeminiProjectDir("/repo/gemini-stale", { tmpRoot });
    assert.equal(firstResolved, staleDir);

    await mkdir(freshDir, { recursive: true });
    await writeFile(join(staleDir, ".project_root"), "/repo/other\n", "utf8");
    await writeFile(join(freshDir, ".project_root"), "/repo/gemini-stale\n", "utf8");

    const secondResolved = await resolveGeminiProjectDir("/repo/gemini-stale", { tmpRoot });
    assert.equal(secondResolved, freshDir);
    assert.equal(geminiProjectDirCache.get(`${tmpRoot}::/repo/gemini-stale`), freshDir);
  });

  it("skips non-matching Gemini directories and still finds the correct project", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "marmonitor-gemini-mixed-"));
    const ignoredDir = join(tmpRoot, "project-ignored");
    const targetDir = join(tmpRoot, "project-target");
    await mkdir(ignoredDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(ignoredDir, ".project_root"), "/repo/other\n", "utf8");
    await writeFile(join(targetDir, ".project_root"), "/repo/gemini-target\n", "utf8");

    geminiProjectDirCache.clear();
    const resolved = await resolveGeminiProjectDir("/repo/gemini-target", { tmpRoot });

    assert.equal(resolved, targetDir);
  });
});

describe("parseClaudeSession", () => {
  it("skips token parsing when includeTokenUsage is false", async () => {
    const pid = 42_424;
    const root = await mkdtemp(join(tmpdir(), "marmonitor-claude-light-"));
    const config = getDefaults();
    config.paths.claudeSessions = [root];
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, `${pid}.json`),
      JSON.stringify({
        cwd: "/repo/project",
        sessionId: "sess-1",
        startedAt: 1_710_000_000_000,
      }),
      "utf8",
    );

    const parsed = await parseClaudeSession(pid, config, { includeTokenUsage: false });

    assert.equal(parsed.cwd, "/repo/project");
    assert.equal(parsed.sessionId, "sess-1");
    assert.equal(parsed.startedAt, 1_710_000_000);
    assert.equal(parsed.sessionMatched, true);
    assert.equal(parsed.tokenUsage, undefined);
    assert.equal(parsed.model, undefined);
  });

  it("can use provided runtime paths for Claude session lookup", async () => {
    const pid = 52_525;
    const root = await mkdtemp(join(tmpdir(), "marmonitor-claude-runtime-paths-"));
    const config = getDefaults();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, `${pid}.json`),
      JSON.stringify({
        cwd: "/repo/runtime-paths",
        sessionId: "sess-runtime-paths",
        startedAt: 1_710_000_000_000,
      }),
      "utf8",
    );

    const parsed = await parseClaudeSession(pid, config, {
      includeTokenUsage: false,
      runtimePaths: {
        claudeProjects: [],
        claudeSessions: [root],
        codexSessions: [],
        extraRoots: [],
      },
    });

    assert.equal(parsed.cwd, "/repo/runtime-paths");
    assert.equal(parsed.sessionId, "sess-runtime-paths");
    assert.equal(parsed.startedAt, 1_710_000_000);
    assert.equal(parsed.sessionMatched, true);
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

  it("can index Codex sessions without token usage in light mode", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const root = join(tmpdir(), `marmonitor-codex-light-${Date.now()}`);
    const dayDir = join(root, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, "session.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "codex-light-1",
            cwd: "/tmp/light-project",
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
                input_tokens: 50,
                cached_input_tokens: 10,
                output_tokens: 5,
                total_tokens: 55,
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
    const sessions = await indexCodexSessions(config, { includeTokenUsage: false });
    const matched = sessions.find((item) => item.filePath === filePath);

    assert.ok(matched);
    assert.equal(matched?.id, "codex-light-1");
    assert.equal(matched?.cwd, "/tmp/light-project");
    assert.equal(matched?.model, "gpt-5.4");
    assert.equal(matched?.totalTokenUsage, undefined);
  });

  it("can use provided runtime paths for Codex indexing", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const root = join(tmpdir(), `marmonitor-codex-runtime-paths-${Date.now()}`);
    const dayDir = join(root, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, "session.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "codex-runtime-paths-1",
            cwd: "/tmp/runtime-paths-project",
            timestamp: new Date("2026-03-28T10:00:00.000Z").toISOString(),
            model_provider: "gpt-5.4",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    setCodexIndexCache(undefined);
    const config = getDefaults();
    const sessions = await indexCodexSessions(config, {
      includeTokenUsage: false,
      runtimePaths: {
        claudeProjects: [],
        claudeSessions: [],
        codexSessions: [root],
        extraRoots: [],
      },
    });
    const matched = sessions.find((item) => item.filePath === filePath);

    assert.ok(matched);
    assert.equal(matched?.id, "codex-runtime-paths-1");
    assert.equal(matched?.cwd, "/tmp/runtime-paths-project");
  });

  it("keeps light Codex indexing from poisoning later full indexing", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const root = join(tmpdir(), `marmonitor-codex-cache-${Date.now()}`);
    const dayDir = join(root, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, "session.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "codex-cache-1",
            cwd: "/tmp/cache-project",
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
                input_tokens: 25,
                cached_input_tokens: 5,
                output_tokens: 7,
                total_tokens: 32,
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

    const lightSessions = await indexCodexSessions(config, { includeTokenUsage: false });
    const lightMatched = lightSessions.find((item) => item.filePath === filePath);
    assert.ok(lightMatched);
    assert.equal(lightMatched?.totalTokenUsage, undefined);

    const fullSessions = await indexCodexSessions(config);
    const fullMatched = fullSessions.find((item) => item.filePath === filePath);
    assert.ok(fullMatched);
    assert.deepEqual(fullMatched?.totalTokenUsage, {
      input_tokens: 25,
      cached_input_tokens: 5,
      output_tokens: 7,
      total_tokens: 32,
    });
    assert.ok(codexIndexCache.full);
    assert.ok(codexIndexCache.light);
  });

  it("skips missing Codex roots and still indexes the available root", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const missingRoot = join(tmpdir(), `marmonitor-codex-missing-${Date.now()}`);
    const root = join(tmpdir(), `marmonitor-codex-available-${Date.now()}`);
    const dayDir = join(root, yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });
    const filePath = join(dayDir, "session.jsonl");
    await writeFile(
      filePath,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "codex-available-1",
          cwd: "/tmp/available-project",
          timestamp: new Date("2026-03-28T10:00:00.000Z").toISOString(),
          model_provider: "gpt-5.4",
        },
      }),
      "utf8",
    );

    setCodexIndexCache(undefined);
    const config = getDefaults();
    config.paths.codexSessions = [missingRoot, root];

    const sessions = await indexCodexSessions(config, { includeTokenUsage: false });
    const matched = sessions.find((item) => item.filePath === filePath);

    assert.ok(matched);
    assert.equal(matched?.id, "codex-available-1");
    assert.equal(matched?.cwd, "/tmp/available-project");
  });
});

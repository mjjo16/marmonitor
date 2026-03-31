import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getDefaults } from "../dist/config/index.js";
import {
  claudePhaseCache,
  claudeProjectDirCache,
  claudeSessionRegistry,
  codexPhaseCache,
  processCwdCache,
  processStartCache,
  stdoutHeuristicCache,
} from "../dist/scanner/cache.js";
import { detectClaudePhase, resolveClaudeSessionFile } from "../dist/scanner/claude.js";
import { detectCodexPhase } from "../dist/scanner/codex.js";
import { getProcessCwd, getProcessStartTime } from "../dist/scanner/process.js";
import { getPidUsageCached, listProcessesCached } from "../dist/scanner/runtime-snapshot.js";
import { detectCliStdoutPhase } from "../dist/scanner/status.js";

describe("shared stdout heuristic cache", () => {
  it("reuses stdout heuristic result across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-stdout-cache-"));
    const config = getDefaults();
    config.performance.stdoutHeuristicTtlMs = 10_000;
    const agent = { pid: 91_001, cwd: "/repo/shared-stdout" };
    let resolveCalls = 0;
    let captureCalls = 0;

    stdoutHeuristicCache.clear();
    const first = await detectCliStdoutPhase(agent, config, {
      cacheRoot,
      nowMs: 1_000,
      resolveTmuxJumpTarget: async () => {
        resolveCalls += 1;
        return {
          pane: {
            target: "0:1.1",
            sessionName: "0",
            windowIndex: 1,
            paneIndex: 1,
            panePid: 1,
            cwd: agent.cwd,
          },
          match: "cwd",
        };
      },
      captureTmuxPaneOutput: async () => {
        captureCalls += 1;
        return "Action required\n1. Allow once";
      },
    });

    assert.equal(first, "permission");
    assert.equal(resolveCalls, 1);
    assert.equal(captureCalls, 1);

    stdoutHeuristicCache.clear();
    const second = await detectCliStdoutPhase(agent, config, {
      cacheRoot,
      nowMs: 2_000,
      resolveTmuxJumpTarget: async () => {
        throw new Error("shared cache miss");
      },
      captureTmuxPaneOutput: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, "permission");
    assert.equal(resolveCalls, 1);
    assert.equal(captureCalls, 1);
  });

  it("reuses negative stdout heuristic result across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-stdout-negative-"));
    const config = getDefaults();
    config.performance.stdoutHeuristicTtlMs = 10_000;
    const agent = { pid: 91_002, cwd: "/repo/shared-stdout-negative" };
    let resolveCalls = 0;

    stdoutHeuristicCache.clear();
    const first = await detectCliStdoutPhase(agent, config, {
      cacheRoot,
      nowMs: 1_000,
      resolveTmuxJumpTarget: async () => {
        resolveCalls += 1;
        return undefined;
      },
    });

    assert.equal(first, undefined);
    assert.equal(resolveCalls, 1);

    stdoutHeuristicCache.clear();
    const second = await detectCliStdoutPhase(agent, config, {
      cacheRoot,
      nowMs: 2_000,
      resolveTmuxJumpTarget: async () => {
        throw new Error("shared cache miss");
      },
      captureTmuxPaneOutput: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, undefined);
    assert.equal(resolveCalls, 1);
  });
});

describe("shared process cwd cache", () => {
  it("reuses cwd results across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-cwd-cache-"));
    let execCalls = 0;

    processCwdCache.clear();
    const first = await getProcessCwd(88_001, {
      cacheRoot,
      nowMs: 1_000,
      execFile: async () => {
        execCalls += 1;
        return {
          stdout: "p88001\nn/repo/shared-cwd\n",
          stderr: "",
        };
      },
    });

    assert.equal(first, "/repo/shared-cwd");
    assert.equal(execCalls, 1);

    processCwdCache.clear();
    const second = await getProcessCwd(88_001, {
      cacheRoot,
      nowMs: 2_000,
      execFile: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, "/repo/shared-cwd");
    assert.equal(execCalls, 1);
  });

  it("reuses negative cwd results across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-cwd-negative-"));
    let execCalls = 0;

    processCwdCache.clear();
    const first = await getProcessCwd(88_002, {
      cacheRoot,
      nowMs: 1_000,
      execFile: async () => {
        execCalls += 1;
        throw new Error("lsof failed");
      },
    });

    assert.equal(first, undefined);
    assert.equal(execCalls, 1);

    processCwdCache.clear();
    const second = await getProcessCwd(88_002, {
      cacheRoot,
      nowMs: 2_000,
      execFile: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, undefined);
    assert.equal(execCalls, 1);
  });
});

describe("shared process start cache", () => {
  it("reuses start times across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-start-cache-"));
    let execCalls = 0;

    processStartCache.clear();
    const first = await getProcessStartTime(88_003, {
      cacheRoot,
      nowMs: 1_000,
      execFile: async () => {
        execCalls += 1;
        return {
          stdout: "Mon Mar 31 10:00:00 2026\n",
          stderr: "",
        };
      },
    });

    assert.equal(first, new Date("Mon Mar 31 10:00:00 2026").getTime() / 1000);
    assert.equal(execCalls, 1);

    processStartCache.clear();
    const second = await getProcessStartTime(88_003, {
      cacheRoot,
      nowMs: 2_000,
      execFile: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, first);
    assert.equal(execCalls, 1);
  });

  it("reuses negative start times across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-start-negative-"));
    let execCalls = 0;

    processStartCache.clear();
    const first = await getProcessStartTime(88_004, {
      cacheRoot,
      nowMs: 1_000,
      execFile: async () => {
        execCalls += 1;
        throw new Error("ps failed");
      },
    });

    assert.equal(first, undefined);
    assert.equal(execCalls, 1);

    processStartCache.clear();
    const second = await getProcessStartTime(88_004, {
      cacheRoot,
      nowMs: 2_000,
      execFile: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, undefined);
    assert.equal(execCalls, 1);
  });
});

describe("shared process runtime snapshots", () => {
  it("reuses ps-list results across fresh calls", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-process-list-cache-"));
    let calls = 0;

    const first = await listProcessesCached({
      cacheRoot,
      nowMs: 1_000,
      psList: async () => {
        calls += 1;
        return [
          {
            pid: 101,
            ppid: 1,
            name: "codex",
            cmd: "codex --sandbox",
          },
        ];
      },
    });

    assert.deepEqual(first, [
      {
        pid: 101,
        ppid: 1,
        name: "codex",
        cmd: "codex --sandbox",
      },
    ]);
    assert.equal(calls, 1);

    const second = await listProcessesCached({
      cacheRoot,
      nowMs: 1_500,
      psList: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });

  it("reuses pidusage results across fresh calls", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-pidusage-cache-"));
    let calls = 0;

    const first = await getPidUsageCached([101, 202], {
      cacheRoot,
      nowMs: 1_000,
      pidusage: async () => {
        calls += 1;
        return {
          101: { cpu: 12.3, memory: 456 },
          202: { cpu: 4.5, memory: 789 },
        };
      },
    });

    assert.deepEqual(first, {
      101: { cpu: 12.3, memory: 456 },
      202: { cpu: 4.5, memory: 789 },
    });
    assert.equal(calls, 1);

    const second = await getPidUsageCached([202, 101], {
      cacheRoot,
      nowMs: 1_500,
      pidusage: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });
});

describe("shared Claude caches", () => {
  it("reuses resolved Claude session files across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-claude-session-cache-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "marmonitor-claude-projects-"));
    const cwd = "/tmp/shared-claude-project";
    const sessionId = "claude-session-shared";
    const startedAt = 1_717_171_717;
    const projectDirName = cwd.replace(/[/.]/g, "-");
    const sessionDir = join(projectRoot, projectDirName);
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    const runtimePaths = {
      claudeProjects: [projectRoot],
      claudeSessions: [],
      codexSessions: [],
      extraRoots: [],
    };

    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionFile, "", "utf8");

    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const first = await resolveClaudeSessionFile(
      sessionId,
      cwd,
      startedAt,
      undefined,
      runtimePaths,
      {
        cacheRoot,
        nowMs: 1_000,
      },
    );

    assert.equal(first, sessionFile);

    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const second = await resolveClaudeSessionFile(
      sessionId,
      cwd,
      startedAt,
      undefined,
      {
        claudeProjects: [],
        claudeSessions: [],
        codexSessions: [],
        extraRoots: [],
      },
      {
        cacheRoot,
        nowMs: 2_000,
      },
    );

    assert.equal(second, sessionFile);
  });

  it("reuses Claude phase results across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-claude-phase-cache-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "marmonitor-claude-projects-"));
    const cwd = "/tmp/shared-claude-phase";
    const sessionId = "claude-phase-shared";
    const startedAt = 1_717_171_717;
    const projectDirName = cwd.replace(/[/.]/g, "-");
    const sessionDir = join(projectRoot, projectDirName);
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    const runtimePaths = {
      claudeProjects: [projectRoot],
      claudeSessions: [],
      codexSessions: [],
      extraRoots: [],
    };

    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${[
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-03-31T10:00:00.000Z",
          message: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();
    claudePhaseCache.clear();

    const first = await detectClaudePhase(sessionId, cwd, startedAt, undefined, runtimePaths, {
      cacheRoot,
      nowMs: 1_000,
    });

    assert.deepEqual(first, {
      phase: "done",
      lastResponseAt: new Date("2026-03-31T10:00:00.000Z").getTime() / 1000,
      lastActivityAt: new Date("2026-03-31T10:00:00.000Z").getTime() / 1000,
    });

    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();
    claudePhaseCache.clear();

    const second = await detectClaudePhase(sessionId, cwd, startedAt, undefined, runtimePaths, {
      cacheRoot,
      nowMs: 2_000,
      openFile: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.deepEqual(second, first);
  });
});

describe("shared Codex phase cache", () => {
  it("reuses Codex phase results across in-memory cache clears", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "marmonitor-codex-phase-cache-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "marmonitor-codex-sessions-"));
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dayDir = join(sessionsRoot, yyyy, mm, dd);
    const sessionFile = join(dayDir, "codex-phase-shared.jsonl");

    await mkdir(dayDir, { recursive: true });
    await writeFile(
      sessionFile,
      `${[
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "codex-phase-shared",
            cwd: "/tmp/shared-codex-phase",
            timestamp: new Date("2026-03-31T10:00:00.000Z").toISOString(),
            model_provider: "gpt-5.4",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
          },
        }),
      ].join("\n")}\n`,
      "utf8",
    );

    codexPhaseCache.clear();
    const first = await detectCodexPhase(sessionFile, undefined, {
      cacheRoot,
      nowMs: 1_000,
    });

    assert.equal(first, "done");

    codexPhaseCache.clear();
    const second = await detectCodexPhase(sessionFile, undefined, {
      cacheRoot,
      nowMs: 2_000,
      openFile: async () => {
        throw new Error("shared cache miss");
      },
    });

    assert.equal(second, "done");
  });
});

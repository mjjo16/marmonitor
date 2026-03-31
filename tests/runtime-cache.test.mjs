import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { getDefaults } from "../dist/config/index.js";
import { processCwdCache, stdoutHeuristicCache } from "../dist/scanner/cache.js";
import { getProcessCwd } from "../dist/scanner/process.js";
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

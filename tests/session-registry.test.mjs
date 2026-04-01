import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadRegistryFromFile,
  pruneRegistry,
  saveRegistryToFile,
  updateRegistry,
} from "../dist/scanner/session-registry.js";

describe("session registry", () => {
  it("updates registry with new session", () => {
    const registry = new Map();
    updateRegistry(registry, [
      {
        agentName: "Claude Code",
        pid: 1234,
        sessionId: "abc",
        cwd: "/projects/test",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        startedAt: 1774000000,
      },
    ]);
    assert.equal(registry.size, 1);
    const entry = registry.get("abc");
    assert.ok(entry);
    assert.equal(entry.agent, "Claude Code");
    assert.equal(entry.history.length, 1);
    assert.equal(entry.history[0].pid, 1234);
  });

  it("appends to history when PID changes for same sessionId", () => {
    const registry = new Map();
    updateRegistry(registry, [
      {
        agentName: "Claude Code",
        pid: 1234,
        sessionId: "abc",
        cwd: "/projects/test",
        startedAt: 1774000000,
      },
    ]);
    updateRegistry(registry, [
      {
        agentName: "Claude Code",
        pid: 5678,
        sessionId: "abc",
        cwd: "/projects/test",
        startedAt: 1774010000,
      },
    ]);
    const entry = registry.get("abc");
    assert.equal(entry.history.length, 2);
    assert.equal(entry.history[0].pid, 1234);
    assert.equal(entry.history[1].pid, 5678);
  });

  it("does not duplicate history for same PID", () => {
    const registry = new Map();
    updateRegistry(registry, [
      {
        agentName: "Claude Code",
        pid: 1234,
        sessionId: "abc",
        cwd: "/projects/test",
        startedAt: 1774000000,
      },
    ]);
    updateRegistry(registry, [
      {
        agentName: "Claude Code",
        pid: 1234,
        sessionId: "abc",
        cwd: "/projects/test",
        startedAt: 1774000000,
      },
    ]);
    assert.equal(registry.get("abc").history.length, 1);
  });

  it("skips sessions without sessionId", () => {
    const registry = new Map();
    updateRegistry(registry, [{ agentName: "Claude Code", pid: 1234, cwd: "/projects/test" }]);
    assert.equal(registry.size, 0);
  });

  it("accumulates token usage", () => {
    const registry = new Map();
    updateRegistry(registry, [
      {
        agentName: "Claude Code",
        pid: 1234,
        sessionId: "abc",
        cwd: "/test",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 50,
          cacheCreationTokens: 0,
        },
      },
    ]);
    const entry = registry.get("abc");
    assert.equal(entry.totalTokens.input, 100);
    assert.equal(entry.totalTokens.output, 200);
    assert.equal(entry.totalTokens.cache, 50);
  });

  it("saves and loads registry from file", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-registry-test-${Date.now()}`), {
      recursive: true,
    });
    const filePath = join(dir, "registry.json");
    try {
      const registry = new Map();
      updateRegistry(registry, [
        {
          agentName: "Claude Code",
          pid: 1234,
          sessionId: "abc",
          cwd: "/test",
          startedAt: 1774000000,
        },
      ]);
      await saveRegistryToFile(filePath, registry);

      const loaded = new Map();
      await loadRegistryFromFile(filePath, loaded);
      assert.equal(loaded.size, 1);
      assert.equal(loaded.get("abc").agent, "Claude Code");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("loads empty registry when file missing", async () => {
    const loaded = new Map();
    await loadRegistryFromFile("/tmp/nonexistent-registry-12345.json", loaded);
    assert.equal(loaded.size, 0);
  });

  it("prunes sessions older than maxAgeDays", () => {
    const registry = new Map();
    const now = Math.floor(Date.now() / 1000);
    const thirtyOneDaysAgo = now - 31 * 86400;
    const twoDaysAgo = now - 2 * 86400;

    registry.set("old-session", {
      sessionId: "old-session",
      agent: "Claude Code",
      cwd: "/test",
      history: [{ pid: 1, startedAt: thirtyOneDaysAgo }],
      totalTokens: { input: 100, output: 50, cache: 0 },
      lastActivityAt: thirtyOneDaysAgo,
    });
    registry.set("recent-session", {
      sessionId: "recent-session",
      agent: "Claude Code",
      cwd: "/test",
      history: [{ pid: 2, startedAt: twoDaysAgo }],
      totalTokens: { input: 200, output: 100, cache: 0 },
      lastActivityAt: twoDaysAgo,
    });

    const pruned = pruneRegistry(registry, 30);
    assert.equal(pruned, 1);
    assert.equal(registry.size, 1);
    assert.ok(registry.has("recent-session"));
    assert.ok(!registry.has("old-session"));
  });

  it("does not prune sessions without lastActivityAt", () => {
    const registry = new Map();
    registry.set("no-activity", {
      sessionId: "no-activity",
      agent: "Claude Code",
      cwd: "/test",
      history: [{ pid: 1, startedAt: 1774000000 }],
      totalTokens: { input: 0, output: 0, cache: 0 },
    });
    const pruned = pruneRegistry(registry, 30);
    assert.equal(pruned, 0);
    assert.equal(registry.size, 1);
  });
});

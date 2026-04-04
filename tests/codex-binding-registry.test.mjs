import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildCodexBindingKey,
  loadCodexBindingRegistryFromFile,
  markMissingCodexBindingsDead,
  pruneCodexBindingRegistry,
  saveCodexBindingRegistryToFile,
  selectCodexBindingSession,
  upsertCodexBindingRecord,
} from "../dist/scanner/codex-binding-registry.js";

describe("codex binding registry", () => {
  it("builds a stable key from pid and process start time", () => {
    assert.equal(buildCodexBindingKey(19077, 1775000000), "19077:1775000000");
    assert.equal(buildCodexBindingKey(19077, undefined), "19077:0");
  });

  it("saves and loads registry records from file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-codex-binding-"));
    const filePath = join(dir, "codex-binding-registry.json");

    try {
      const registry = new Map([
        [
          "19077:1775000000",
          {
            pid: 19077,
            processStartedAt: 1775000000,
            cwd: "/Users/macrent/.ai/projects/mjjo",
            threadId: "019d1f7f",
            rolloutPath: "/tmp/rollout.jsonl",
            lastVerifiedAt: 1775180138,
            confidence: "high",
            unstableCount: 0,
          },
        ],
      ]);

      await saveCodexBindingRegistryToFile(filePath, registry);

      const loaded = new Map();
      await loadCodexBindingRegistryFromFile(filePath, loaded);

      assert.equal(loaded.size, 1);
      assert.equal(loaded.get("19077:1775000000").threadId, "019d1f7f");
      assert.equal(loaded.get("19077:1775000000").confidence, "high");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("prunes dead bindings older than cutoff", () => {
    const now = Math.floor(Date.now() / 1000);
    const registry = new Map([
      [
        "old",
        {
          pid: 1,
          cwd: "/tmp/old",
          threadId: "old",
          rolloutPath: "/tmp/old.jsonl",
          lastVerifiedAt: now - 10 * 86400,
          confidence: "low",
          unstableCount: 2,
          deadAt: now - 8 * 86400,
        },
      ],
      [
        "alive",
        {
          pid: 2,
          cwd: "/tmp/alive",
          threadId: "alive",
          rolloutPath: "/tmp/alive.jsonl",
          lastVerifiedAt: now,
          confidence: "high",
          unstableCount: 0,
        },
      ],
    ]);

    const pruned = pruneCodexBindingRegistry(registry, 7);
    assert.equal(pruned, 1);
    assert.equal(registry.has("old"), false);
    assert.equal(registry.has("alive"), true);
  });

  it("reuses an existing binding when the same thread still exists", () => {
    const registry = new Map([
      [
        "19077:1775000000",
        {
          pid: 19077,
          processStartedAt: 1775000000,
          cwd: "/Users/macrent/.ai/projects/mjjo",
          threadId: "019d1f7f",
          rolloutPath: "/tmp/rollout.jsonl",
          lastVerifiedAt: 1775180138,
          confidence: "high",
          unstableCount: 0,
        },
      ],
    ]);

    const matched = selectCodexBindingSession(
      registry,
      19077,
      1775000000,
      "/Users/macrent/.ai/projects/mjjo",
      [
        {
          id: "019d1f7f",
          cwd: "/Users/macrent/.ai/projects/mjjo",
          filePath: "/tmp/rollout.jsonl",
          timestamp: 1774349925,
        },
      ],
    );

    assert.equal(matched?.id, "019d1f7f");
  });

  it("requires processStartedAt rather than thread timestamp for registry reuse", () => {
    const registry = new Map([
      [
        "19077:1775000000",
        {
          pid: 19077,
          processStartedAt: 1775000000,
          cwd: "/Users/macrent/.ai/projects/mjjo",
          threadId: "019d1f7f",
          rolloutPath: "/tmp/rollout.jsonl",
          lastVerifiedAt: 1775180138,
          confidence: "high",
          unstableCount: 0,
        },
      ],
    ]);

    const sessions = [
      {
        id: "019d1f7f",
        cwd: "/Users/macrent/.ai/projects/mjjo",
        filePath: "/tmp/rollout.jsonl",
        timestamp: 1774349925,
      },
    ];

    const wrong = selectCodexBindingSession(
      registry,
      19077,
      1774349925,
      "/Users/macrent/.ai/projects/mjjo",
      sessions,
    );
    const correct = selectCodexBindingSession(
      registry,
      19077,
      1775000000,
      "/Users/macrent/.ai/projects/mjjo",
      sessions,
    );

    assert.equal(wrong, undefined);
    assert.equal(correct?.id, "019d1f7f");
  });

  it("marks missing bindings dead and updates the existing binding in place", () => {
    const registry = new Map();
    upsertCodexBindingRecord(registry, {
      pid: 19077,
      processStartedAt: 1775000000,
      cwd: "/Users/macrent/.ai/projects/mjjo",
      matched: {
        id: "019d1f7f",
        cwd: "/Users/macrent/.ai/projects/mjjo",
        filePath: "/tmp/rollout.jsonl",
        timestamp: 1774349925,
        lastActivityAt: 1775180138,
      },
    });

    const updated = markMissingCodexBindingsDead(registry, new Set());
    assert.equal(updated, 1);
    assert.equal(registry.get("19077:1775000000")?.deadAt !== undefined, true);
  });
});

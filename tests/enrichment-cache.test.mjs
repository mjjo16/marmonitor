import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadEnrichmentCache, saveEnrichmentCache } from "../dist/scanner/enrichment-file-cache.js";

describe("enrichment file cache", () => {
  it("saves and loads enrichment data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-test-"));
    const cachePath = join(dir, "enrichment-cache.json");
    try {
      const data = {
        "Claude Code:1234": {
          cwd: "/projects/test",
          sessionId: "abc",
          phase: "thinking",
          lastActivityAt: 1774000000,
        },
      };
      await saveEnrichmentCache(cachePath, data);
      const loaded = await loadEnrichmentCache(cachePath, 10000);
      assert.deepEqual(loaded, data);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns empty object when file does not exist", async () => {
    const loaded = await loadEnrichmentCache("/tmp/nonexistent-12345.json", 10000);
    assert.deepEqual(loaded, {});
  });

  it("returns empty object when cache is expired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-test-"));
    const cachePath = join(dir, "enrichment-cache.json");
    try {
      await saveEnrichmentCache(cachePath, { "test:1": { cwd: "/tmp" } });
      // Wait briefly so mtime is in the past
      await new Promise((r) => setTimeout(r, 50));
      const loaded = await loadEnrichmentCache(cachePath, 1);
      assert.deepEqual(loaded, {});
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns empty object when file is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-test-"));
    const cachePath = join(dir, "enrichment-cache.json");
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(cachePath, "{invalid json", "utf-8");
      const loaded = await loadEnrichmentCache(cachePath, 10000);
      assert.deepEqual(loaded, {});
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireSnapshotLock, releaseSnapshotLock } from "../dist/scanner/snapshot-lock.js";

describe("snapshot lock", () => {
  it("acquires lock when no lock file exists", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-lock-test-${Date.now()}`), {
      recursive: true,
    });
    const lockPath = join(dir, "snapshot.lock");
    try {
      const acquired = await acquireSnapshotLock(lockPath, 5000);
      assert.equal(acquired, true);
    } finally {
      await releaseSnapshotLock(lockPath);
      await rm(dir, { recursive: true });
    }
  });

  it("does not acquire when lock is held (not expired)", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-lock-test-${Date.now()}`), {
      recursive: true,
    });
    const lockPath = join(dir, "snapshot.lock");
    try {
      // Create a fresh lock file
      await writeFile(lockPath, String(Date.now()), "utf-8");
      const acquired = await acquireSnapshotLock(lockPath, 5000);
      assert.equal(acquired, false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("acquires when lock is expired", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-lock-test-${Date.now()}`), {
      recursive: true,
    });
    const lockPath = join(dir, "snapshot.lock");
    try {
      // Create an expired lock (timestamp in the past)
      await writeFile(lockPath, String(Date.now() - 10000), "utf-8");
      const acquired = await acquireSnapshotLock(lockPath, 5000);
      assert.equal(acquired, true);
    } finally {
      await releaseSnapshotLock(lockPath);
      await rm(dir, { recursive: true });
    }
  });

  it("release removes lock file", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-lock-test-${Date.now()}`), {
      recursive: true,
    });
    const lockPath = join(dir, "snapshot.lock");
    try {
      await writeFile(lockPath, String(Date.now()), "utf-8");
      await releaseSnapshotLock(lockPath);
      let exists = true;
      try {
        await stat(lockPath);
      } catch {
        exists = false;
      }
      assert.equal(exists, false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

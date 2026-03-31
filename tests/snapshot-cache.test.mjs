import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  acquireSnapshotRefreshLock,
  releaseSnapshotRefreshLock,
  snapshotRefreshLockFile,
} from "../dist/snapshot-cache.js";

describe("snapshot refresh lock", () => {
  it("creates the lock parent directory on a fresh temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "marmonitor-snapshot-lock-"));
    const acquired = await acquireSnapshotRefreshLock("light", false, root);

    assert.equal(acquired, true);
    await stat(snapshotRefreshLockFile("light", false, root));

    await releaseSnapshotRefreshLock("light", false, root);
  });
});

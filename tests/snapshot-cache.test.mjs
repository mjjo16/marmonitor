import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  acquireSnapshotRefreshLock,
  releaseSnapshotRefreshLock,
  snapshotRefreshLockFile,
  writeCacheFileAtomically,
} from "../dist/snapshot-cache.js";

describe("snapshot refresh lock", () => {
  it("creates the lock parent directory on a fresh temp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "marmonitor-snapshot-lock-"));
    const acquired = await acquireSnapshotRefreshLock("light", false, root);

    assert.equal(acquired, true);
    await stat(snapshotRefreshLockFile("light", false, root));

    await releaseSnapshotRefreshLock("light", false, root);
  });

  it("writes cache files atomically without leaving temp files behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "marmonitor-snapshot-write-"));
    const path = join(root, "marmonitor", "statusline.txt");

    await writeCacheFileAtomically(path, "first");
    assert.equal(await readFile(path, "utf8"), "first");

    await writeCacheFileAtomically(path, "second");
    assert.equal(await readFile(path, "utf8"), "second");

    const entries = await readdir(dirname(path));
    assert.deepEqual(entries, ["statusline.txt"]);
  });
});

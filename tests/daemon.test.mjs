import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isDaemonRunning,
  readDaemonPid,
  readDaemonSnapshot,
  writeDaemonPid,
  writeDaemonSnapshot,
} from "../dist/scanner/daemon-utils.js";

describe("daemon utilities", () => {
  it("writes and reads daemon PID", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-daemon-test-${Date.now()}`), {
      recursive: true,
    });
    const pidPath = join(dir, "daemon.pid");
    try {
      await writeDaemonPid(pidPath, 12345);
      const pid = await readDaemonPid(pidPath);
      assert.equal(pid, 12345);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns undefined when PID file does not exist", async () => {
    const pid = await readDaemonPid("/tmp/nonexistent-daemon-pid-12345");
    assert.equal(pid, undefined);
  });

  it("writes and reads daemon snapshot", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-daemon-test-${Date.now()}`), {
      recursive: true,
    });
    const snapshotPath = join(dir, "daemon-snapshot.json");
    try {
      const data = [{ agentName: "Claude Code", pid: 1234, status: "Active" }];
      await writeDaemonSnapshot(snapshotPath, data);
      const loaded = await readDaemonSnapshot(snapshotPath, 10000);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].agentName, "Claude Code");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns empty array when snapshot expired", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-daemon-test-${Date.now()}`), {
      recursive: true,
    });
    const snapshotPath = join(dir, "daemon-snapshot.json");
    try {
      await writeDaemonSnapshot(snapshotPath, [{ agentName: "test" }]);
      await new Promise((r) => setTimeout(r, 50));
      const loaded = await readDaemonSnapshot(snapshotPath, 1);
      assert.deepEqual(loaded, []);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns empty array when snapshot file missing", async () => {
    const loaded = await readDaemonSnapshot("/tmp/nonexistent-snapshot-12345", 10000);
    assert.deepEqual(loaded, []);
  });

  it("isDaemonRunning returns false when no PID file", async () => {
    const running = await isDaemonRunning("/tmp/nonexistent-pid-12345");
    assert.equal(running, false);
  });
});

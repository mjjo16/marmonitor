import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  clearJumpAnchor,
  loadJumpAnchor,
  saveJumpAnchor,
  saveJumpAnchorIfMissing,
} from "../dist/tmux/jump-anchor.js";

describe("jump anchor", () => {
  it("saves and loads an anchor by client tty", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-anchor-test-${Date.now()}`), {
      recursive: true,
    });
    const anchorPath = join(dir, "jump-anchors.json");
    try {
      await saveJumpAnchor(anchorPath, "/dev/ttys001", {
        session: "main",
        window: "0",
        pane: "main:0.1",
      });
      const anchor = await loadJumpAnchor(anchorPath, "/dev/ttys001");
      assert.ok(anchor);
      assert.equal(anchor.session, "main");
      assert.equal(anchor.window, "0");
      assert.equal(anchor.pane, "main:0.1");
      assert.ok(anchor.savedAt > 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns undefined when no anchor exists for client", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-anchor-test-${Date.now()}`), {
      recursive: true,
    });
    const anchorPath = join(dir, "jump-anchors.json");
    try {
      await saveJumpAnchor(anchorPath, "/dev/ttys001", {
        session: "main",
        window: "0",
        pane: "main:0.1",
      });
      const anchor = await loadJumpAnchor(anchorPath, "/dev/ttys999");
      assert.equal(anchor, undefined);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns undefined when anchor file does not exist", async () => {
    const anchor = await loadJumpAnchor("/tmp/nonexistent-anchors-12345.json", "/dev/ttys001");
    assert.equal(anchor, undefined);
  });

  it("overwrites previous anchor for same client", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-anchor-test-${Date.now()}`), {
      recursive: true,
    });
    const anchorPath = join(dir, "jump-anchors.json");
    try {
      await saveJumpAnchor(anchorPath, "/dev/ttys001", {
        session: "main",
        window: "0",
        pane: "main:0.1",
      });
      await saveJumpAnchor(anchorPath, "/dev/ttys001", {
        session: "work",
        window: "2",
        pane: "work:2.0",
      });
      const anchor = await loadJumpAnchor(anchorPath, "/dev/ttys001");
      assert.ok(anchor);
      assert.equal(anchor.session, "work");
      assert.equal(anchor.pane, "work:2.0");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("preserves the first anchor when save-if-missing is used repeatedly", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-anchor-test-${Date.now()}`), {
      recursive: true,
    });
    const anchorPath = join(dir, "jump-anchors.json");
    try {
      const firstSaved = await saveJumpAnchorIfMissing(anchorPath, "/dev/ttys001", {
        session: "main",
        window: "0",
        pane: "main:0.1",
      });
      const secondSaved = await saveJumpAnchorIfMissing(anchorPath, "/dev/ttys001", {
        session: "work",
        window: "2",
        pane: "work:2.0",
      });
      const anchor = await loadJumpAnchor(anchorPath, "/dev/ttys001");
      assert.equal(firstSaved, true);
      assert.equal(secondSaved, false);
      assert.ok(anchor);
      assert.equal(anchor.session, "main");
      assert.equal(anchor.pane, "main:0.1");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("clears the anchor after jump-back success path cleanup", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-anchor-test-${Date.now()}`), {
      recursive: true,
    });
    const anchorPath = join(dir, "jump-anchors.json");
    try {
      await saveJumpAnchor(anchorPath, "/dev/ttys001", {
        session: "main",
        window: "0",
        pane: "main:0.1",
      });
      const removed = await clearJumpAnchor(anchorPath, "/dev/ttys001");
      const anchor = await loadJumpAnchor(anchorPath, "/dev/ttys001");
      assert.equal(removed, true);
      assert.equal(anchor, undefined);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

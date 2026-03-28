import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPidInTree,
  parseProcessTree,
  parseTmuxPanes,
  selectTmuxPaneForAgent,
} from "../dist/tmux/index.js";

describe("parseTmuxPanes", () => {
  it("parses tmux list-panes output", () => {
    const panes = parseTmuxPanes("mjjo:1.2\t1234\t/Users/macrent/.ai/projects/mjjo\n");
    assert.deepEqual(panes, [
      {
        target: "mjjo:1.2",
        sessionName: "mjjo",
        windowIndex: 1,
        paneIndex: 2,
        panePid: 1234,
        cwd: "/Users/macrent/.ai/projects/mjjo",
      },
    ]);
  });

  it("ignores malformed pane rows", () => {
    const panes = parseTmuxPanes("bad-line\nmjjo:1.2\t1234\t/repo\n");
    assert.equal(panes.length, 1);
    assert.equal(panes[0].target, "mjjo:1.2");
  });
});

describe("parseProcessTree / isPidInTree", () => {
  it("detects descendant pid relationships", () => {
    const childMap = parseProcessTree("100 1\n200 100\n300 200\n");
    assert.equal(isPidInTree(100, 300, childMap), true);
    assert.equal(isPidInTree(200, 300, childMap), true);
    assert.equal(isPidInTree(300, 100, childMap), false);
  });
});

describe("selectTmuxPaneForAgent", () => {
  const panes = [
    {
      target: "mjjo:1.2",
      sessionName: "mjjo",
      windowIndex: 1,
      paneIndex: 2,
      panePid: 100,
      cwd: "/repo/a",
    },
    {
      target: "mjjo:2.1",
      sessionName: "mjjo",
      windowIndex: 2,
      paneIndex: 1,
      panePid: 500,
      cwd: "/repo/b",
    },
  ];

  it("prefers pid-tree match over cwd match", () => {
    const childMap = parseProcessTree("100 1\n200 100\n700 500\n");
    const result = selectTmuxPaneForAgent({ pid: 200, cwd: "/repo/b" }, panes, childMap);
    assert.equal(result?.pane.target, "mjjo:1.2");
    assert.equal(result?.match, "pid-tree");
  });

  it("falls back to cwd match when pid tree has no match", () => {
    const childMap = parseProcessTree("100 1\n200 100\n");
    const result = selectTmuxPaneForAgent({ pid: 999, cwd: "/repo/b" }, panes, childMap);
    assert.equal(result?.pane.target, "mjjo:2.1");
    assert.equal(result?.match, "cwd");
  });
});

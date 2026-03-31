import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getTmuxRuntimeSnapshot,
  isPidInTree,
  parseProcessTree,
  parseTmuxPanes,
  resetTmuxRuntimeSnapshotForTests,
  resolveTmuxJumpTarget,
  selectTmuxPaneForAgent,
} from "../dist/tmux/index.js";

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

describe("tmux runtime snapshot", () => {
  it("shares in-flight tmux snapshot loads across concurrent callers", async () => {
    resetTmuxRuntimeSnapshotForTests();
    let paneLoads = 0;
    let treeLoads = 0;
    const panesDeferred = createDeferred();
    const treeDeferred = createDeferred();
    const loaders = {
      listPanes: async () => {
        paneLoads += 1;
        return await panesDeferred.promise;
      },
      getProcessTree: async () => {
        treeLoads += 1;
        return await treeDeferred.promise;
      },
    };

    const first = getTmuxRuntimeSnapshot(loaders);
    const second = getTmuxRuntimeSnapshot(loaders);

    assert.equal(paneLoads, 1);
    assert.equal(treeLoads, 1);

    panesDeferred.resolve([
      {
        target: "mjjo:1.2",
        sessionName: "mjjo",
        windowIndex: 1,
        paneIndex: 2,
        panePid: 100,
        cwd: "/repo/a",
      },
    ]);
    treeDeferred.resolve(new Map([[1, [100]]]));

    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
    assert.strictEqual(firstSnapshot, secondSnapshot);
    assert.equal(firstSnapshot.panes[0].target, "mjjo:1.2");
    assert.deepEqual(firstSnapshot.childMap.get(1), [100]);
  });

  it("rebuilds the tmux snapshot after the in-flight load finishes", async () => {
    resetTmuxRuntimeSnapshotForTests();
    let paneLoads = 0;
    let treeLoads = 0;
    const loaders = {
      listPanes: async () => {
        paneLoads += 1;
        return [];
      },
      getProcessTree: async () => {
        treeLoads += 1;
        return new Map();
      },
    };

    await getTmuxRuntimeSnapshot(loaders);
    await getTmuxRuntimeSnapshot(loaders);

    assert.equal(paneLoads, 2);
    assert.equal(treeLoads, 2);
  });

  it("resolves concurrent jump targets from one shared tmux snapshot", async () => {
    resetTmuxRuntimeSnapshotForTests();
    let paneLoads = 0;
    let treeLoads = 0;
    const panesDeferred = createDeferred();
    const treeDeferred = createDeferred();
    const loaders = {
      listPanes: async () => {
        paneLoads += 1;
        return await panesDeferred.promise;
      },
      getProcessTree: async () => {
        treeLoads += 1;
        return await treeDeferred.promise;
      },
    };

    const first = resolveTmuxJumpTarget({ pid: 200, cwd: "/repo/a" }, loaders);
    const second = resolveTmuxJumpTarget({ pid: 999, cwd: "/repo/b" }, loaders);

    assert.equal(paneLoads, 1);
    assert.equal(treeLoads, 1);

    panesDeferred.resolve([
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
    ]);
    treeDeferred.resolve(parseProcessTree("100 1\n200 100\n"));

    const [firstTarget, secondTarget] = await Promise.all([first, second]);
    assert.equal(firstTarget?.pane.target, "mjjo:1.2");
    assert.equal(firstTarget?.match, "pid-tree");
    assert.equal(secondTarget?.pane.target, "mjjo:2.1");
    assert.equal(secondTarget?.match, "cwd");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTmuxAttentionPills, buildTmuxBadgeBar } from "../dist/output/utils.js";
import { findClickedAgent, parseStatusClickToken } from "../dist/tmux/status-click.js";

describe("status click parsing", () => {
  it("parses pid click tokens", () => {
    assert.deepEqual(parseStatusClickToken("pid:123"), { kind: "jump", pid: 123 });
  });

  it("parses jump-back click tokens", () => {
    assert.deepEqual(parseStatusClickToken("jump-back"), { kind: "jump-back" });
  });

  it("returns undefined for unsupported tokens", () => {
    assert.equal(parseStatusClickToken(undefined), undefined);
    assert.equal(parseStatusClickToken(""), undefined);
    assert.equal(parseStatusClickToken("focus"), undefined);
  });

  it("finds the clicked agent by pid", () => {
    const agents = [
      { pid: 11, cwd: "/tmp/a" },
      { pid: 22, cwd: "/tmp/b" },
    ];

    const found = findClickedAgent(agents, { kind: "jump", pid: 22 });
    assert.equal(found?.pid, 22);
  });
});

describe("tmux statusline click ranges", () => {
  it("wraps attention pills in tmux user ranges", () => {
    const text = buildTmuxAttentionPills(
      [
        {
          kind: "permission",
          priority: 1,
          pid: 30,
          agentName: "Claude Code",
          cwd: "/Users/macrent/.ai/projects/mjjo",
          status: "Active",
          phase: "permission",
        },
      ],
      5,
    );

    assert.match(text, /#\[range=user\|pid:30\]/);
    assert.match(text, /#\[norange\]/);
  });

  it("wraps jump-back indicator in a tmux user range", () => {
    const text = buildTmuxBadgeBar(
      {
        aliveCount: 1,
        waitingCount: 0,
        riskCount: 0,
        stalledCount: 0,
        unmatchedCount: 0,
        activeCount: 1,
        highCpuCount: 0,
      },
      undefined,
      "basic",
      true,
    );

    assert.match(text, /#\[range=user\|jump-back\]/);
    assert.match(text, /↩/);
  });
});

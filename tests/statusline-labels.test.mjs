import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTmuxAttentionPills } from "../dist/output/utils.js";

function item(pid, cwd = "/projects/local/ai") {
  return { pid, cwd, agentName: "Claude Code", kind: "active", priority: 3, status: "Idle" };
}
function target(sessionName, windowIndex, paneIndex) {
  return { match: "pid-tree", pane: { sessionName, windowIndex, paneIndex } };
}
function render(items, options = {}, width = 0) {
  return buildTmuxAttentionPills(items, 5, width, "text", undefined, options);
}

describe("same-path statusline labels (#75)", () => {
  it("keeps a unique path unchanged in auto mode", () => {
    assert.match(
      render([item(10)], { tmuxTargets: new Map([[10, target("local", 2, 1)]]) }),
      /local\/ai/,
    );
    assert.doesNotMatch(render([item(10)]), /@|local\/ai pid:/);
  });
  it("appends verified pane coordinates to duplicate paths", () => {
    const text = render([item(10), item(20)], {
      tmuxTargets: new Map([
        [10, target("local", 2, 1)],
        [20, target("local", 2, 3)],
      ]),
    });
    assert.match(text, /local\/ai @local:2\.1/);
    assert.match(text, /local\/ai @local:2\.3/);
    assert.match(text, /range=user\|pid:10/);
    assert.match(text, /range=user\|pid:20/);
  });
  it("uses PID when no verified pane or session ID is available", () => {
    const text = render([item(10), item(20)]);
    assert.match(text, /pid:10/);
    assert.match(text, /pid:20/);
    assert.match(text, /local\/ai pid:10/);
  });
  it("detects collisions with hidden siblings before list truncation", () => {
    const items = [item(10), item(20)];
    const text = buildTmuxAttentionPills(items.slice(0, 1), 1, undefined, "text", undefined, {
      collisionItems: items,
    });
    assert.match(text, /local\/ai pid:10/);
    assert.doesNotMatch(text, /local\/ai pid:20/);
  });
  it("also handles different paths with identical shortened names", () => {
    const text = render([item(10, "/one/local/ai"), item(20, "/two/local/ai")]);
    assert.match(text, /local\/ai pid:10/);
    assert.match(text, /local\/ai pid:20/);
  });
  it("preserves path-only mode and offers tmux-only labels", () => {
    assert.doesNotMatch(render([item(10), item(20)], { mode: "path" }), /local\/ai pid:/);
    const text = render([item(10)], {
      mode: "tmux",
      tmuxTargets: new Map([[10, target("local", 2, 1)]]),
    });
    assert.match(text, /@local:2\.1/);
    assert.doesNotMatch(text, /local\/ai/);
  });
  it("falls back to PID when two CLIs share the same pane", () => {
    const pane = target("local", 2, 1);
    const text = render([item(10), item(20)], {
      tmuxTargets: new Map([
        [10, pane],
        [20, pane],
      ]),
    });
    assert.match(text, /local\/ai pid:10/);
    assert.match(text, /local\/ai pid:20/);
  });
  it("keeps a distinguishing identity in narrow layouts with long session names", () => {
    const items = [item(10), item(20)];
    const options = {
      tmuxTargets: new Map([
        [10, target("very-long-session-name", 2, 1)],
        [20, target("very-long-session-name", 2, 3)],
      ]),
    };
    const text = render(items, options, 60);
    assert.match(text, /•Cl [^\n]*pid:10/);
  });
  it("does not emit raw tmux style or control characters from a session name", () => {
    const text = render([item(10)], {
      mode: "tmux",
      tmuxTargets: new Map([[10, target("x#[bold]\n", 2, 1)]]),
    });
    assert.match(text, /x##\[bold\]/);
    assert.doesNotMatch(text, /\n/);
  });
});

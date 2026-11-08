import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderStatusline } from "../dist/output/index.js";
import { partitionSessions } from "../dist/sessions.js";

function session(pid, status, agentName = "Codex") {
  return { pid, status, agentName, cwd: "/tmp/project", cpuPercent: 0, memoryMb: 20 };
}

describe("running CLI counts are independent of metadata binding", () => {
  it("keeps a newly detected CLI in the count as its file appears and disappears", () => {
    const cli = session(1, "Unmatched");
    for (const status of ["Unmatched", "Idle", "Active", "Stalled", "Unmatched"]) {
      const { running, matched, unmatched } = partitionSessions([{ ...cli, status }]);
      assert.equal(running.length, 1);
      assert.equal(matched.length + unmatched.length, running.length);
    }
    assert.equal(partitionSessions([{ ...cli, status: "Dead" }]).running.length, 0);
  });

  it("counts an unbound CLI in tmux badges and compact output, excluding historical sessions", async () => {
    const agents = [session(1, "Unmatched"), session(2, "Idle", "Claude Code"), session(3, "Dead")];
    const badges = await renderStatusline(agents, "tmux-badges");
    assert.match(badges, /Cx 1/);
    assert.match(badges, /Cl 1/);
    assert.match(badges, /⚠ 1/);
    assert.match(await renderStatusline(agents, "compact"), /AI2/);
  });

  it("does not render AI:0 when the only CLI has no session file yet", async () => {
    assert.match(await renderStatusline([session(1, "Unmatched")], "tmux-badges"), /Cx 1/);
  });
});

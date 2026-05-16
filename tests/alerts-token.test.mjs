import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertStore, checkTokenAlert } from "../dist/alerts/index.js";

function makeAgent(tokenUsage, overrides = {}) {
  return {
    agentName: "Claude Code",
    pid: 1234,
    cwd: "/tmp/agent",
    cpuPercent: 0,
    memoryMb: 0,
    status: "Active",
    model: "claude-opus-4-7",
    tokenUsage,
    ...overrides,
  };
}

describe("checkTokenAlert (context-size gate, #102 G2)", () => {
  it("fires context_critical when lastInputTokens crosses critAt (Claude normal path)", () => {
    const store = new AlertStore();
    const alert = checkTokenAlert(
      store,
      makeAgent({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        lastInputTokens: 180_000, // 90% of 200K
      }),
    );
    assert.ok(alert, "alert should be created");
    assert.equal(alert?.type, "context_critical");
  });

  it("does NOT fire when lastInputTokens is missing — Codex cumulative regression (#102)", () => {
    // Reproduces the production case at 2026-05-08: Codex sessions arrive
    // with a multi-million cumulative inputTokens but no lastInputTokens,
    // which previously fell back to cumulative and produced 8983%/15700% alerts.
    const store = new AlertStore();
    const alert = checkTokenAlert(
      store,
      makeAgent(
        {
          inputTokens: 1_500_000, // cumulative across the session
          outputTokens: 12_000,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 1_512_000,
          // lastInputTokens intentionally omitted
        },
        { agentName: "Codex", model: "gpt-5.4", pid: 2222 },
      ),
    );
    assert.equal(alert, undefined);
  });

  it("does not fire when tokenUsage is absent", () => {
    const store = new AlertStore();
    const alert = checkTokenAlert(store, makeAgent(undefined));
    assert.equal(alert, undefined);
  });

  it("does not fire when lastInputTokens is below thresholds", () => {
    const store = new AlertStore();
    const alert = checkTokenAlert(
      store,
      makeAgent({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        lastInputTokens: 50_000, // 25%
      }),
    );
    assert.equal(alert, undefined);
  });
});

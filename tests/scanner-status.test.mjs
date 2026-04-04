import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import {
  applyStatusHysteresis,
  determineStatus,
  refreshLastActivityAt,
} from "../dist/scanner/status.js";

describe("scanner status heuristics", () => {
  it("refreshes Codex lastActivityAt when live signals exist", () => {
    const now = 1775223000;
    assert.equal(refreshLastActivityAt(1775194317, 2.5, "tool", 0.5, "Codex", now), now);
    assert.equal(refreshLastActivityAt(1775194317, 0.0, "thinking", 0.5, "Codex", now), now);
  });

  it("does not refresh lastActivityAt for non-Codex sessions", () => {
    assert.equal(
      refreshLastActivityAt(1775194317, 2.5, "tool", 0.5, "Claude Code", 1775223000),
      1775194317,
    );
  });

  it("keeps quiet Codex sessions idle for longer before marking stalled", () => {
    const config = getDefaults();
    assert.equal(determineStatus(0.0, 7 * 60 * 60, true, undefined, config, "Codex"), "Idle");
    assert.equal(determineStatus(0.0, 30 * 60 * 60, true, undefined, config, "Codex"), "Stalled");
  });

  it("keeps a recently active session from dropping immediately to idle", () => {
    assert.equal(applyStatusHysteresis("Idle", "Active", 10, undefined, "Claude Code"), "Active");
    assert.equal(applyStatusHysteresis("Stalled", "Active", 10, "thinking", "Codex"), "Active");
  });

  it("keeps idle sessions from dropping immediately to stalled", () => {
    assert.equal(applyStatusHysteresis("Stalled", "Idle", 20, undefined, "Claude Code"), "Idle");
    assert.equal(applyStatusHysteresis("Stalled", "Idle", 40, "tool", "Codex"), "Idle");
    assert.equal(
      applyStatusHysteresis("Stalled", "Idle", 120, undefined, "Claude Code"),
      "Stalled",
    );
  });
});

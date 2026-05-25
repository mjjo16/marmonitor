import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { shouldRunTokenAlerts } from "../dist/scanner/daemon-loop.js";

describe("shouldRunTokenAlerts (daemon token-alert gate)", () => {
  it("fires only when both enabled and tokens are true", () => {
    const cfg = getDefaults();
    cfg.alerts.enabled = true;
    cfg.alerts.tokens = true;
    assert.equal(shouldRunTokenAlerts(cfg), true);
  });

  it("skips when alerts.tokens is false (security path stays on master toggle)", () => {
    const cfg = getDefaults();
    cfg.alerts.enabled = true;
    cfg.alerts.tokens = false;
    assert.equal(shouldRunTokenAlerts(cfg), false);
  });

  it("skips when master alerts.enabled is false even if tokens is true", () => {
    const cfg = getDefaults();
    cfg.alerts.enabled = false;
    cfg.alerts.tokens = true;
    assert.equal(shouldRunTokenAlerts(cfg), false);
  });

  it("skips when both toggles are off (default state)", () => {
    const cfg = getDefaults();
    cfg.alerts.enabled = false;
    cfg.alerts.tokens = false;
    assert.equal(shouldRunTokenAlerts(cfg), false);
  });
});

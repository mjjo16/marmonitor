import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderUnavailableStatusline } from "../dist/output/index.js";

describe("renderUnavailableStatusline", () => {
  it("returns plain fallback for default formats", () => {
    assert.equal(renderUnavailableStatusline("compact"), "marmonitor unavailable");
    assert.equal(renderUnavailableStatusline("tmux-badges"), "marmonitor unavailable");
  });

  it("returns parseable fallback for wezterm pills", () => {
    assert.equal(
      renderUnavailableStatusline("wezterm-pills"),
      "focus\tmarmonitor unavailable\t#bac2de\t#313244",
    );
  });
});

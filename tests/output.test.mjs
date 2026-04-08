import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abbreviateModel, renderUnavailableStatusline } from "../dist/output/index.js";

describe("abbreviateModel", () => {
  it("abbreviates Claude model variants", () => {
    assert.equal(abbreviateModel("claude-opus-4-6"), "opus");
    assert.equal(abbreviateModel("claude-sonnet-4-6"), "sonnet");
    assert.equal(abbreviateModel("claude-haiku-4-5"), "haiku");
  });

  it("returns short non-Claude model names as-is", () => {
    assert.equal(abbreviateModel("gpt-5.4"), "gpt-5.4");
    assert.equal(abbreviateModel("gpt-4o"), "gpt-4o");
  });

  it("truncates long non-Claude model names to 11 chars", () => {
    assert.equal(abbreviateModel("some-very-long-model-name"), "some-very-l");
  });

  it("returns — for undefined or empty", () => {
    assert.equal(abbreviateModel(undefined), "—");
    assert.equal(abbreviateModel(""), "—");
  });
});

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

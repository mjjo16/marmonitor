import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderInstallBanner,
  renderInstallInfo,
  renderRuntimeBanner,
  renderRuntimeInfo,
  supportsInlineBannerImage,
} from "../dist/banner/index.js";

describe("supportsInlineBannerImage", () => {
  it("keeps inline image disabled by default", () => {
    assert.equal(supportsInlineBannerImage({ TERM_PROGRAM: "iTerm.app" }), false);
    assert.equal(supportsInlineBannerImage({ TERM_PROGRAM: "WezTerm" }), false);
    assert.equal(supportsInlineBannerImage({ MARMONITOR_ENABLE_INLINE_IMAGE: "1" }), true);
  });
});

describe("renderInstallInfo", () => {
  it("includes setup guide, commands, and docs link", () => {
    const text = renderInstallInfo();
    assert.match(text, /marmonitor v\d+\.\d+\.\d+/);
    assert.match(text, /marmonitor setup tmux/);
    assert.match(text, /marmonitor update-integration/);
    assert.match(text, /marmonitor status/);
    assert.match(text, /uninstall-integration/);
    assert.match(text, /github\.com\/mjjo16\/marmonitor/);
  });
});

describe("renderRuntimeInfo", () => {
  it("includes active session count when provided", () => {
    assert.match(renderRuntimeInfo(3), /3 active sessions/);
  });
});

describe("renderInstallBanner / renderRuntimeBanner", () => {
  it("falls back to ANSI/text when inline image is not supported", () => {
    assert.match(
      renderInstallBanner({ TERM_PROGRAM: "WezTerm" }),
      /Standing guard over your AI coding sessions/,
    );
    assert.match(
      renderRuntimeBanner(2, { TERM_PROGRAM: "WezTerm" }),
      /Monitoring: Claude Code, Codex/,
    );
  });
});

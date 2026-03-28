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
  it("supports iTerm2 only in the current implementation", () => {
    assert.equal(supportsInlineBannerImage({ TERM_PROGRAM: "iTerm.app" }), true);
    assert.equal(supportsInlineBannerImage({ TERM_PROGRAM: "WezTerm" }), false);
  });
});

describe("renderInstallInfo", () => {
  it("includes quick start commands and docs link", () => {
    const text = renderInstallInfo();
    assert.match(text, /marmonitor v0\.1\.0/);
    assert.match(text, /marmonitor status/);
    assert.match(text, /marmonitor dock/);
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
      /Standing guard over your AI sessions/,
    );
    assert.match(
      renderRuntimeBanner(2, { TERM_PROGRAM: "WezTerm" }),
      /Monitoring: Claude Code, Codex/,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifySessionTier } from "../dist/scanner/session-tier.js";

describe("classifySessionTier", () => {
  const now = Date.now() / 1000;

  it("classifies recent activity as hot", () => {
    assert.equal(classifySessionTier(now - 30, now), "hot"); // 30s ago
    assert.equal(classifySessionTier(now - 90, now), "hot"); // 90s ago
  });

  it("classifies moderate activity as warm", () => {
    assert.equal(classifySessionTier(now - 300, now), "warm"); // 5 min ago
    assert.equal(classifySessionTier(now - 500, now), "warm"); // 8 min ago
  });

  it("classifies old activity as cold", () => {
    assert.equal(classifySessionTier(now - 700, now), "cold"); // 11 min ago
    assert.equal(classifySessionTier(now - 3600, now), "cold"); // 1 hour ago
  });

  it("classifies undefined activity as cold", () => {
    assert.equal(classifySessionTier(undefined, now), "cold");
  });

  it("classifies high CPU as hot regardless of activity time", () => {
    assert.equal(classifySessionTier(now - 3600, now, 5.0), "hot");
  });

  it("does not promote to hot on low CPU", () => {
    assert.equal(classifySessionTier(now - 3600, now, 0.1), "cold");
  });

  it("classifies permission phase as hot regardless of activity time", () => {
    assert.equal(classifySessionTier(now - 3600, now, 0, "permission"), "hot");
  });

  it("classifies thinking phase as hot regardless of activity time", () => {
    assert.equal(classifySessionTier(now - 3600, now, 0, "thinking"), "hot");
  });

  it("does not promote done phase to hot", () => {
    assert.equal(classifySessionTier(now - 3600, now, 0, "done"), "cold");
  });
});

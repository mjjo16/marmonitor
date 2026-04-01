import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("perf instrumentation", () => {
  it("perfStart/perfEnd return elapsed time when enabled", async () => {
    // Set env before import
    process.env.MARMONITOR_PERF = "1";
    // Dynamic import to pick up env
    const { perfStart, perfEnd, perfEnabled } = await import("../dist/scanner/perf.js");
    assert.equal(perfEnabled(), true);
    perfStart("test-timer");
    await new Promise((r) => setTimeout(r, 10));
    const elapsed = perfEnd("test-timer");
    assert.ok(elapsed >= 5, `expected >=5ms, got ${elapsed}ms`);
    process.env.MARMONITOR_PERF = undefined;
  });

  it("perfEnd returns 0 for unknown label", async () => {
    process.env.MARMONITOR_PERF = "1";
    const { perfEnd } = await import("../dist/scanner/perf.js");
    const elapsed = perfEnd("nonexistent");
    assert.equal(elapsed, 0);
    process.env.MARMONITOR_PERF = undefined;
  });
});

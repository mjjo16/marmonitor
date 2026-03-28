import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TERMINAL_RESTORE_SEQUENCE, formatProcessFailure } from "../dist/process-safety.js";

describe("process safety helpers", () => {
  it("formats Error objects using stack or message", () => {
    const error = new Error("boom");
    const text = formatProcessFailure(error);
    assert.match(text, /boom/);
  });

  it("formats non-Error rejection reasons safely", () => {
    assert.equal(formatProcessFailure("oops"), "oops");
    assert.equal(formatProcessFailure(42), "42");
  });

  it("exports a terminal restore sequence", () => {
    assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[0m"));
    assert.ok(TERMINAL_RESTORE_SEQUENCE.includes("\x1b[?25h"));
  });
});

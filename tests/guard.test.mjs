import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getDefaults } from "../dist/config/index.js";
import {
  detectGuardTriggers,
  evaluateGuard,
  formatGuardOutput,
  parseHookEvent,
} from "../dist/guard/index.js";

const execFileAsync = promisify(execFile);

describe("parseHookEvent", () => {
  it("parses Claude hook payload", () => {
    const event = parseHookEvent(
      JSON.stringify({
        tool_name: "Bash",
        cwd: "/repo",
        tool_input: { command: "rm -rf /tmp/test" },
      }),
    );
    assert.equal(event?.toolName, "Bash");
    assert.equal(event?.cwd, "/repo");
    assert.equal(event?.command, "rm -rf /tmp/test");
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(parseHookEvent("{not-json"), undefined);
  });
});

describe("detectGuardTriggers", () => {
  it("detects dangerous commands", () => {
    const triggers = detectGuardTriggers({
      agent: "claude",
      toolName: "Bash",
      cwd: "/repo",
      command: "rm -rf /",
      raw: {},
    });
    assert.deepEqual(triggers, ["dangerous_command"]);
  });

  it("detects out-of-cwd write", () => {
    const triggers = detectGuardTriggers({
      agent: "claude",
      toolName: "Write",
      cwd: "/repo",
      filePath: "/other/file.txt",
      raw: {},
    });
    assert.deepEqual(triggers, ["out_of_cwd_write"]);
  });
});

describe("evaluateGuard", () => {
  it("allows when intervention is disabled", () => {
    const result = evaluateGuard(getDefaults(), {
      agent: "claude",
      toolName: "Bash",
      cwd: "/repo",
      command: "rm -rf /",
      raw: {},
    });
    assert.equal(result.decision, "allow");
  });

  it("blocks when a matching block rule is configured", () => {
    const config = getDefaults();
    config.intervention.enabled = true;
    config.intervention.defaultAction = "alert";
    config.intervention.rules = [
      {
        id: "block-rm-rf",
        enabled: true,
        trigger: "dangerous_command",
        action: "block",
        agents: ["claude"],
        match: { commandRegex: "rm\\s+-rf\\s+/" },
      },
    ];

    const result = evaluateGuard(config, {
      agent: "claude",
      toolName: "Bash",
      cwd: "/repo",
      command: "rm -rf /",
      raw: {},
    });
    assert.equal(result.decision, "block");
    assert.equal(result.matchedRuleId, "block-rm-rf");
  });

  it("falls back to defaultAction when a trigger exists but no rule matches", () => {
    const config = getDefaults();
    config.intervention.enabled = true;
    config.intervention.defaultAction = "block";

    const result = evaluateGuard(config, {
      agent: "claude",
      toolName: "Bash",
      cwd: "/repo",
      command: "rm -rf /",
      raw: {},
    });
    assert.equal(result.decision, "block");
    assert.equal(result.trigger, "dangerous_command");
  });

  it("ignores invalid commandRegex rules instead of crashing", () => {
    const config = getDefaults();
    config.intervention.enabled = true;
    config.intervention.defaultAction = "alert";
    config.intervention.rules = [
      {
        id: "bad-regex",
        enabled: true,
        trigger: "dangerous_command",
        action: "block",
        match: { commandRegex: "[" },
      },
    ];

    const result = evaluateGuard(config, {
      agent: "claude",
      toolName: "Bash",
      cwd: "/repo",
      command: "rm -rf /",
      raw: {},
    });
    assert.equal(result.decision, "allow");
    assert.equal(result.action, "alert");
  });
});

describe("formatGuardOutput", () => {
  it("formats allow result", () => {
    assert.equal(formatGuardOutput({ decision: "allow" }), '{"decision":"allow"}');
  });

  it("formats block result", () => {
    assert.equal(
      formatGuardOutput({ decision: "block", message: "Blocked by marmonitor" }),
      '{"decision":"block","message":"Blocked by marmonitor"}',
    );
  });
});

describe("guard CLI fail-open", () => {
  it("returns allow for malformed stdin payload", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const { stdout } = await execFileAsync("node", ["bin/marmonitor.js", "guard"], {
      cwd: repoRoot,
      input: "{not-json",
    });
    assert.equal(stdout.trim(), '{"decision":"allow"}');
  });
});

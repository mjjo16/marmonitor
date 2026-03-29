import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  getConfigDir,
  getConfigSearchPaths,
  getDefaultConfigPath,
  getDefaults,
  loadConfig,
  resolveConfigPath,
  resolveRuntimeDataPaths,
} from "../dist/config/index.js";

describe("getDefaults", () => {
  it("returns complete config with all fields", () => {
    const config = getDefaults();
    assert.ok(config.status);
    assert.ok(config.display);
    assert.ok(config.agents);
    assert.ok(config.intervention);
    assert.ok(config.integration);
    assert.ok(config.paths);
    assert.ok(config.performance);
  });

  it("has reasonable default values", () => {
    const config = getDefaults();
    assert.equal(config.status.activeCpuThreshold, 0.5);
    assert.equal(config.status.stalledAfterMin, 30);
    assert.equal(config.status.minMemoryMb, 5);
    assert.equal(config.status.phaseDecay.thinking, 20);
    assert.equal(config.status.phaseDecay.tool, 30);
    assert.equal(config.status.phaseDecay.permission, 0);
    assert.equal(config.status.phaseDecay.done, 5);
    assert.ok(config.status.stdoutHeuristic.approvalPatterns.includes("would you like to"));
    assert.ok(config.status.stdoutHeuristic.clearPatterns.includes("applying patch"));
    assert.equal(config.display.showDead, false);
    assert.equal(config.display.sortBy, "cwd");
    assert.equal(config.display.attentionLimit, 10);
    assert.equal(config.display.statuslineAttentionLimit, 5);
    assert.equal(config.intervention.enabled, false);
    assert.equal(config.intervention.mode, "alert");
    assert.equal(config.intervention.defaultAction, "alert");
    assert.equal(config.integration.tmux.keys.attentionPopup, "a");
    assert.equal(config.integration.tmux.keys.jumpPopup, "j");
    assert.equal(config.integration.tmux.keys.dockToggle, "m");
    assert.deepEqual(config.integration.tmux.keys.directJump, ["M-1", "M-2", "M-3", "M-4", "M-5"]);
    assert.equal(config.integration.wezterm.enabled, false);
    assert.equal(config.integration.wezterm.statusTtlSec, 15);
    assert.equal(config.integration.banner.install, true);
    assert.equal(config.integration.banner.runtime, false);
    assert.deepEqual(config.paths.claudeProjects, []);
    assert.deepEqual(config.paths.claudeSessions, []);
    assert.deepEqual(config.paths.codexSessions, []);
    assert.deepEqual(config.paths.extraRoots, []);
    assert.equal(config.performance.snapshotTtlMs, 2000);
    assert.equal(config.performance.statuslineTtlMs, 2000);
    assert.equal(config.performance.stdoutHeuristicTtlMs, 2000);
  });

  it("includes all three default agents", () => {
    const config = getDefaults();
    assert.ok(config.agents["Claude Code"]);
    assert.ok(config.agents.Codex);
    assert.ok(config.agents.Gemini);
    assert.deepEqual(config.agents["Claude Code"].processNames, ["claude"]);
  });

  it("returns independent copies (mutation does not leak)", () => {
    const a = getDefaults();
    a.status.stalledAfterMin = 999;
    const b = getDefaults();
    assert.equal(b.status.stalledAfterMin, 30, "b should not see a's mutation");
  });
});

describe("config path helpers", () => {
  it("derives the default config file path from the config dir", () => {
    assert.equal(getDefaultConfigPath(), join(getConfigDir(), "settings.json"));
  });

  it("returns search paths in priority order", () => {
    const paths = getConfigSearchPaths();
    assert.equal(paths.length, 2);
    assert.match(paths[0], /marmonitor\/settings\.json$/);
    assert.match(paths[1], /\.marmonitor\.json$/);
  });

  it("returns a custom config path as-is", () => {
    assert.equal(
      resolveConfigPath("/nonexistent/path/settings.json"),
      "/nonexistent/path/settings.json",
    );
  });

  it("resolves runtime data paths from defaults, config, and env", () => {
    const previousClaudeHome = process.env.MARMONITOR_CLAUDE_HOME;
    const previousCodexSessions = process.env.MARMONITOR_CODEX_SESSIONS;
    process.env.MARMONITOR_CLAUDE_HOME = "~/alt-claude";
    process.env.MARMONITOR_CODEX_SESSIONS = "~/one:~/two";

    try {
      const config = getDefaults();
      config.paths.claudeProjects = ["~/manual-projects"];
      config.paths.extraRoots = ["~/work"];
      const resolved = resolveRuntimeDataPaths(config);
      assert.ok(resolved.claudeProjects.some((path) => path.endsWith("/alt-claude/projects")));
      assert.ok(resolved.claudeProjects.some((path) => path.endsWith("/manual-projects")));
      assert.ok(resolved.codexSessions.some((path) => path.endsWith("/one")));
      assert.ok(resolved.codexSessions.some((path) => path.endsWith("/two")));
      assert.ok(resolved.extraRoots.some((path) => path.endsWith("/work")));
    } finally {
      if (previousClaudeHome === undefined) process.env.MARMONITOR_CLAUDE_HOME = undefined;
      else process.env.MARMONITOR_CLAUDE_HOME = previousClaudeHome;
      if (previousCodexSessions === undefined) process.env.MARMONITOR_CODEX_SESSIONS = undefined;
      else process.env.MARMONITOR_CODEX_SESSIONS = previousCodexSessions;
    }
  });
});

describe("loadConfig", () => {
  it("returns defaults when config file does not exist", async () => {
    const config = await loadConfig("/nonexistent/path/settings.json");
    assert.equal(config.status.activeCpuThreshold, 0.5);
    assert.equal(config.status.stalledAfterMin, 30);
  });

  it("returns valid config when path is undefined", async () => {
    const config = await loadConfig(undefined);
    assert.ok(config.status);
    assert.ok(config.display);
    assert.ok(config.agents);
    // Values should be defaults or user overrides — both are valid
    assert.equal(typeof config.status.activeCpuThreshold, "number");
    assert.equal(typeof config.status.stalledAfterMin, "number");
  });

  it("merges partial overrides from a custom config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        status: { stalledAfterMin: 10 },
        display: { sortBy: "pid", attentionLimit: 7, statuslineAttentionLimit: 4 },
      }),
    );

    try {
      const config = await loadConfig(path);
      assert.equal(config.status.activeCpuThreshold, 0.5);
      assert.equal(config.status.stalledAfterMin, 10);
      assert.equal(config.status.phaseDecay.thinking, 20);
      assert.equal(config.display.showDead, false);
      assert.equal(config.display.sortBy, "pid");
      assert.equal(config.display.attentionLimit, 7);
      assert.equal(config.display.statuslineAttentionLimit, 4);
      assert.equal(config.intervention.enabled, false);
      assert.equal(config.integration.tmux.keys.attentionPopup, "a");
      assert.equal(config.integration.wezterm.enabled, false);
      assert.equal(config.integration.wezterm.statusTtlSec, 15);
      assert.equal(config.integration.banner.install, true);
      assert.deepEqual(config.paths.extraRoots, []);
      assert.equal(config.performance.snapshotTtlMs, 2000);
      assert.deepEqual(config.agents.Codex.processNames, ["codex"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges intervention overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        intervention: {
          enabled: true,
          defaultAction: "block",
          rules: [{ id: "x", enabled: true, trigger: "dangerous_command", action: "block" }],
        },
      }),
    );

    try {
      const config = await loadConfig(path);
      assert.equal(config.intervention.enabled, true);
      assert.equal(config.intervention.mode, "alert");
      assert.equal(config.intervention.defaultAction, "block");
      assert.equal(config.intervention.rules.length, 1);
      assert.equal(config.intervention.rules[0].id, "x");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to defaults when config JSON is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(path, "{ invalid json");

    try {
      const config = await loadConfig(path);
      assert.equal(config.status.stalledAfterMin, 30);
      assert.equal(config.display.sortBy, "cwd");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges phaseDecay overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        status: {
          phaseDecay: {
            thinking: 10,
            tool: 45,
          },
        },
      }),
    );

    try {
      const config = await loadConfig(path);
      assert.equal(config.status.phaseDecay.thinking, 10);
      assert.equal(config.status.phaseDecay.tool, 45);
      assert.equal(config.status.phaseDecay.permission, 0);
      assert.equal(config.status.phaseDecay.done, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges stdout heuristic overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        status: {
          stdoutHeuristic: {
            approvalPatterns: ["please approve", "need confirmation"],
            clearPatterns: ["resumed work"],
          },
        },
      }),
    );

    try {
      const config = await loadConfig(path);
      assert.deepEqual(config.status.stdoutHeuristic.approvalPatterns, [
        "please approve",
        "need confirmation",
      ]);
      assert.deepEqual(config.status.stdoutHeuristic.clearPatterns, ["resumed work"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges tmux shortcut overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        integration: {
          tmux: {
            keys: {
              attentionPopup: "A",
              jumpPopup: "J",
              directJump: ["M-F1", "M-F2"],
            },
          },
        },
      }),
    );

    try {
      const config = await loadConfig(path);
      assert.equal(config.integration.tmux.keys.attentionPopup, "A");
      assert.equal(config.integration.tmux.keys.jumpPopup, "J");
      assert.equal(config.integration.tmux.keys.dockToggle, "m");
      assert.deepEqual(config.integration.tmux.keys.directJump, ["M-F1", "M-F2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges path, wezterm, banner, and performance overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-config-"));
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        integration: {
          wezterm: {
            enabled: false,
            statusTtlSec: 10,
          },
          banner: {
            install: false,
            runtime: true,
          },
        },
        paths: {
          claudeProjects: ["~/alt/.claude/projects"],
          extraRoots: ["~/work"],
        },
        performance: {
          snapshotTtlMs: 3000,
          stdoutHeuristicTtlMs: 2000,
        },
      }),
    );

    try {
      const config = await loadConfig(path);
      assert.equal(config.integration.wezterm.enabled, false);
      assert.equal(config.integration.wezterm.statusTtlSec, 10);
      assert.equal(config.integration.banner.install, false);
      assert.equal(config.integration.banner.runtime, true);
      assert.deepEqual(config.paths.claudeProjects, ["~/alt/.claude/projects"]);
      assert.deepEqual(config.paths.claudeSessions, []);
      assert.deepEqual(config.paths.extraRoots, ["~/work"]);
      assert.equal(config.performance.snapshotTtlMs, 3000);
      assert.equal(config.performance.statuslineTtlMs, 2000);
      assert.equal(config.performance.stdoutHeuristicTtlMs, 2000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

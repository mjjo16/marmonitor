import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderJumpAttentionChooser } from "../dist/output/index.js";
import { parseSelectionInput, selectJumpAttentionItemOnPage } from "../dist/output/utils.js";
import { formatDateKey } from "../dist/scanner/activity-log.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "bin", "marmonitor.js");

function runCli(args, envOverrides = {}) {
  return execFileSync("node", [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TERM_PROGRAM: "Ghostty",
      ...envOverrides,
    },
  });
}

describe("config CLI helpers", () => {
  it("prints config path metadata as JSON", () => {
    const output = runCli(["settings-path", "--json"]);
    const parsed = JSON.parse(output);
    assert.ok(parsed.configDir);
    assert.ok(parsed.defaultPath);
    assert.ok(Array.isArray(parsed.searchPaths));
  });

  it("prints the minimal config sample to stdout", () => {
    const output = runCli(["settings-init", "--stdout"]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.display.attentionLimit, 10);
    assert.equal(parsed.integration.tmux.keys.attentionPopup, "a");
  });

  it("prints the advanced config sample to stdout", () => {
    const output = runCli(["settings-init", "--advanced", "--stdout"]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.integration.wezterm.enabled, false);
    assert.equal(parsed.integration.banner.install, true);
    assert.ok(Array.isArray(parsed.paths.claudeProjects));
  });

  it("includes debug-phase in help output", () => {
    const output = runCli(["--help"]);
    assert.match(output, /debug-phase \[options\]/);
  });

  it("includes update-integration in help output", () => {
    const output = runCli(["--help"]);
    assert.match(output, /update-integration/);
  });

  it("includes phase icon legend in help output", () => {
    const output = runCli(["--help"]);
    assert.match(output, /permission/);
    assert.match(output, /thinking/);
    assert.match(output, /tool/);
    assert.match(output, /done/);
    assert.match(output, /Active/);
    assert.match(output, /Stalled/);
  });

  it("shows no activity when no local activity log exists", async () => {
    const xdgRoot = await mkdir(join(tmpdir(), `marmonitor-cli-empty-${Date.now()}`), {
      recursive: true,
    });
    try {
      const output = runCli(["activity"], { XDG_CONFIG_HOME: xdgRoot });
      assert.match(output, /No activity found\./);
    } finally {
      await rm(xdgRoot, { recursive: true });
    }
  });

  it("prints activity log entries as json", async () => {
    const xdgRoot = await mkdir(join(tmpdir(), `marmonitor-cli-activity-${Date.now()}`), {
      recursive: true,
    });
    try {
      const logDir = join(xdgRoot, "marmonitor", "activity-log");
      await mkdir(logDir, { recursive: true });
      const today = formatDateKey(new Date());
      await writeFile(
        join(logDir, `${today}.jsonl`),
        `${JSON.stringify({
          ts: 1775190000,
          sid: "abc123456789",
          agent: "Claude Code",
          cwd: "/tmp/project",
          tool: "Edit",
          target: "src/cli.ts",
          tokens: { in: 1, out: 73, cache: 1000 },
        })}\n`,
        "utf8",
      );

      const output = runCli(["activity", "--json"], { XDG_CONFIG_HOME: xdgRoot });
      const parsed = JSON.parse(output);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].tool, "Edit");
      assert.equal(parsed[0].target, "src/cli.ts");
    } finally {
      await rm(xdgRoot, { recursive: true });
    }
  });
});

describe("postinstall/preuninstall scripts", () => {
  it("postinstall outputs install guide to stderr", () => {
    const output = execFileSync("node", [join(repoRoot, "bin", "postinstall.cjs")], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stderr is captured via shell redirect
    const merged = execFileSync(
      "sh",
      ["-c", `node "${join(repoRoot, "bin", "postinstall.cjs")}" 2>&1`],
      { encoding: "utf8" },
    );
    assert.match(merged, /marmonitor.*installed/);
    assert.match(merged, /marmonitor setup tmux/);
    assert.match(merged, /marmonitor update-integration/);
    assert.match(merged, /marmonitor status/);
    assert.match(merged, /uninstall-integration/);
  });

  it("preuninstall runs without error", () => {
    const output = execFileSync("node", [join(repoRoot, "bin", "preuninstall.cjs")], {
      encoding: "utf8",
    });
    // Should not throw. Output may be empty if no tmux.conf plugin line.
    assert.equal(typeof output, "string");
  });
});

describe("jump attention chooser", () => {
  it("renders first page with 1-10 numbering", () => {
    const now = Math.floor(Date.now() / 1000);
    const agents = Array.from({ length: 12 }, (_, index) => ({
      agentName: "Claude Code",
      pid: 1000 + index,
      cwd: `/tmp/project-${index + 1}`,
      cpuPercent: 1,
      memoryMb: 100,
      status: "Active",
      sessionMatched: true,
      phase: "thinking",
      startedAt: now - 60,
      lastActivityAt: now - index,
      runtimeSource: "cli",
    }));

    const text = renderJumpAttentionChooser(agents, 1, 10);
    assert.match(text, / 1\)/);
    assert.match(text, /10\)/);
    assert.doesNotMatch(text, /11\)/);
    assert.match(text, /< 1\/2 >/);
  });

  it("renders second page with 1-based page-local numbering", () => {
    const now = Math.floor(Date.now() / 1000);
    const agents = Array.from({ length: 12 }, (_, index) => ({
      agentName: "Codex",
      pid: 2000 + index,
      cwd: `/tmp/project-${index + 1}`,
      cpuPercent: 1,
      memoryMb: 100,
      status: "Active",
      sessionMatched: true,
      phase: "thinking",
      startedAt: now - 60,
      lastActivityAt: now - index,
      runtimeSource: "cli",
    }));

    const text = renderJumpAttentionChooser(agents, 2, 10);
    assert.match(text, /< 2\/2 >/);
    assert.match(text, / 1\)/);
    assert.match(text, / 2\)/);
    assert.doesNotMatch(text, /10\)/);
  });

  it("maps page-local selections back to the correct global item", () => {
    const now = Math.floor(Date.now() / 1000);
    const agents = Array.from({ length: 12 }, (_, index) => ({
      agentName: "Claude Code",
      pid: 3000 + index,
      cwd: `/tmp/project-${index + 1}`,
      cpuPercent: 1,
      memoryMb: 100,
      status: "Active",
      sessionMatched: true,
      phase: "thinking",
      startedAt: now - 60,
      lastActivityAt: now - index,
      runtimeSource: "cli",
    }));

    const item = selectJumpAttentionItemOnPage(agents, 2, 1, 10);
    assert.equal(item?.pid, 3010);
  });

  it("parses arrow-key page navigation and page-local selection input", () => {
    assert.deepEqual(parseSelectionInput("\u001b[C", 10, 1, 2), { kind: "next" });
    assert.deepEqual(parseSelectionInput("\u001b[D", 2, 2, 2), { kind: "prev" });
    assert.deepEqual(parseSelectionInput("0", 10, 1, 2), { kind: "select", selection: 10 });
    assert.deepEqual(parseSelectionInput("2", 2, 2, 2), { kind: "select", selection: 2 });
    assert.deepEqual(parseSelectionInput("q", 2, 1, 2), { kind: "cancel" });
  });
});

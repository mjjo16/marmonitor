import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("refuses clean --kill without explicit PIDs", () => {
    const result = spawnSync(process.execPath, [cliPath, "clean", "--kill"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--kill requires --pid/);
    assert.equal(result.stdout, "");
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

  it("respects --lines limit", async () => {
    const xdgRoot = await mkdir(join(tmpdir(), `marmonitor-cli-lines-${Date.now()}`), {
      recursive: true,
    });
    try {
      const logDir = join(xdgRoot, "marmonitor", "activity-log");
      await mkdir(logDir, { recursive: true });
      const today = formatDateKey(new Date());
      const entries = `${Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({
          ts: 1775190000 + i,
          sid: "abc123456789",
          agent: "Claude Code",
          cwd: "/tmp/project",
          tool: "Edit",
          target: `src/file${i}.ts`,
          tokens: { in: 1, out: 10, cache: 0 },
        }),
      ).join("\n")}\n`;
      await writeFile(join(logDir, `${today}.jsonl`), entries, "utf8");

      const output = runCli(["activity", "--lines", "3"], { XDG_CONFIG_HOME: xdgRoot });
      assert.match(output, /\+7 more/);
    } finally {
      await rm(xdgRoot, { recursive: true });
    }
  });

  it("returns entries in desc order by default (newest first)", async () => {
    const xdgRoot = await mkdir(join(tmpdir(), `marmonitor-cli-order-${Date.now()}`), {
      recursive: true,
    });
    try {
      const logDir = join(xdgRoot, "marmonitor", "activity-log");
      await mkdir(logDir, { recursive: true });
      const today = formatDateKey(new Date());
      const entries = `${[
        {
          ts: 1775190001,
          sid: "abc123456789",
          agent: "Claude Code",
          cwd: "/tmp/p",
          tool: "Edit",
          target: "first.ts",
          tokens: { in: 1, out: 1, cache: 0 },
        },
        {
          ts: 1775190002,
          sid: "abc123456789",
          agent: "Claude Code",
          cwd: "/tmp/p",
          tool: "Edit",
          target: "second.ts",
          tokens: { in: 1, out: 1, cache: 0 },
        },
        {
          ts: 1775190003,
          sid: "abc123456789",
          agent: "Claude Code",
          cwd: "/tmp/p",
          tool: "Edit",
          target: "third.ts",
          tokens: { in: 1, out: 1, cache: 0 },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`;
      await writeFile(join(logDir, `${today}.jsonl`), entries, "utf8");

      // desc (default): third.ts appears before first.ts in JSON output
      const descOut = JSON.parse(runCli(["activity", "--json"], { XDG_CONFIG_HOME: xdgRoot }));
      assert.equal(descOut[0].target, "third.ts");
      assert.equal(descOut[2].target, "first.ts");

      // asc: first.ts appears before third.ts
      const ascOut = JSON.parse(
        runCli(["activity", "--json", "--order", "asc"], { XDG_CONFIG_HOME: xdgRoot }),
      );
      assert.equal(ascOut[0].target, "first.ts");
      assert.equal(ascOut[2].target, "third.ts");
    } finally {
      await rm(xdgRoot, { recursive: true });
    }
  });
});

describe("postinstall/preuninstall scripts", () => {
  // Both scripts intentionally control daemons and edit user configuration.
  // Never let these tests inherit the developer's HOME or runtime directory.
  async function withLifecycleEnv(fn) {
    const root = await mkdtemp(join(tmpdir(), "marmonitor-lifecycle-test-"));
    const home = join(root, "home");
    const runtime = join(root, "tmp");
    await mkdir(home);
    await mkdir(runtime);
    const env = {
      ...process.env,
      HOME: home,
      TMPDIR: runtime,
      TMP: runtime,
      TEMP: runtime,
      XDG_CONFIG_HOME: join(root, "config"),
    };
    try {
      // Verify Node resolves the same isolated paths that the lifecycle
      // scripts will use before allowing any lifecycle script to execute.
      const resolved = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            'console.log(JSON.stringify([require("node:os").homedir(),require("node:os").tmpdir()]))',
          ],
          { env, encoding: "utf8" },
        ),
      );
      assert.deepEqual(resolved, [home, runtime]);
      await fn({ env, home, runtime });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("postinstall outputs install guide to stderr in an isolated environment", async () => {
    await withLifecycleEnv(async ({ env, home, runtime }) => {
      const conf = "# test configuration\n";
      await writeFile(join(home, ".tmux.conf"), conf);
      const result = spawnSync(process.execPath, [join(repoRoot, "bin", "postinstall.cjs")], {
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /marmonitor.*installed/);
      assert.match(result.stderr, /marmonitor setup tmux/);
      assert.match(result.stderr, /marmonitor update-integration/);
      assert.match(result.stderr, /marmonitor status/);
      assert.match(result.stderr, /uninstall-integration/);
      assert.doesNotMatch(result.stderr, /daemon restarted/);
      assert.equal(await readFile(join(home, ".tmux.conf"), "utf8"), conf);
      await assert.rejects(readFile(join(runtime, "marmonitor", "daemon.pid")), { code: "ENOENT" });
    });
  });

  it("preuninstall removes only the isolated fixture's plugin line", async () => {
    await withLifecycleEnv(async ({ env, home }) => {
      const confPath = join(home, ".tmux.conf");
      await writeFile(confPath, "# preserve this\nset -g @plugin 'mjjo16/marmonitor-tmux'\n");
      const output = execFileSync(process.execPath, [join(repoRoot, "bin", "preuninstall.cjs")], {
        env,
        encoding: "utf8",
      });
      assert.match(output, /removed tmux plugin line/);
      assert.doesNotMatch(output, /daemon stopped/);
      assert.equal(await readFile(confPath, "utf8"), "# preserve this\n");
    });
  });
});

describe("jump attention chooser", () => {
  it("keeps label-mode caches separate without requiring session metadata or tmux", async () => {
    const root = await mkdtemp(join(tmpdir(), "marmonitor-label-cli-"));
    const runtime = join(root, "runtime");
    const daemonDir = join(runtime, "marmonitor");
    const configPath = join(root, "settings.json");
    await mkdir(daemonDir, { recursive: true });
    const env = {
      HOME: root,
      TMPDIR: runtime,
      TMP: runtime,
      TEMP: runtime,
      TMUX: "",
      TMUX_TMPDIR: runtime,
      XDG_CONFIG_HOME: root,
    };
    try {
      await writeFile(
        join(daemonDir, "daemon-snapshot.json"),
        JSON.stringify(
          [900001, 900002].map((pid) => ({
            pid,
            agentName: "Claude Code",
            cwd: "/projects/local/ai",
            status: "Idle",
            cpuPercent: 0,
            memoryMb: 20,
          })),
        ),
      );
      await writeFile(
        configPath,
        JSON.stringify({
          display: { statuslineLabel: "path" },
          performance: { statuslineTtlMs: 60000 },
        }),
      );
      const args = ["--statusline", "--statusline-format", "tmux-badges", "--config", configPath];
      const paths = runCli(args, env);
      assert.doesNotMatch(paths, /local\/ai pid:/);
      await writeFile(
        configPath,
        JSON.stringify({
          display: { statuslineLabel: "auto" },
          performance: { statuslineTtlMs: 60000 },
        }),
      );
      const auto = runCli(args, env);
      assert.match(auto, /local\/ai pid:900001/);
      assert.match(auto, /local\/ai pid:900002/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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

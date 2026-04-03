import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendActivityEntries,
  cleanupOldActivityLogs,
  extractClaudeToolUses,
  extractCodexToolUses,
  formatDateKey,
  getRecentDateKeys,
  readActivityLog,
} from "../dist/scanner/activity-log.js";

describe("activity log", () => {
  it("extracts Claude tool_use from assistant JSONL lines", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-03T10:00:00Z",
        message: {
          usage: { input_tokens: 1, output_tokens: 73, cache_read_input_tokens: 1000 },
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/projects/test/src/cli.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-03T10:01:00Z",
        message: {
          usage: { input_tokens: 2, output_tokens: 50, cache_read_input_tokens: 500 },
          content: [
            { type: "tool_use", name: "Bash", input: { command: "npm test\nsome output" } },
          ],
        },
      }),
      JSON.stringify({ type: "user", message: "hello" }),
    ];

    const entries = extractClaudeToolUses(lines, "abc123", "Claude Code", "/projects/test");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tool, "Edit");
    assert.equal(entries[0].target, "/projects/test/src/cli.ts");
    assert.equal(entries[0].tokens.out, 73);
    assert.equal(entries[1].tool, "Bash");
    assert.equal(entries[1].target, "npm test");
  });

  it("extracts Codex tool events from event_msg lines", () => {
    const lines = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-04-03T10:00:00Z",
        payload: {
          type: "exec_command_end",
          command: ["/bin/zsh", "-lc", "git status --short"],
          cwd: "/projects/test",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-04-03T10:01:00Z",
        payload: {
          type: "patch_apply_end",
          stdout: "Success. Updated the following files:\nM /projects/test/src/utils.ts\n",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-04-03T10:02:00Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 200 },
          },
        },
      }),
    ];

    const entries = extractCodexToolUses(lines, "019d1f7f", "Codex", "/projects/test");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].tool, "Bash");
    assert.equal(entries[0].target, "git status --short");
    assert.equal(entries[1].tool, "Edit");
    assert.ok(entries[1].target.includes("utils.ts"));
  });

  it("appends entries to daily log file and reads them back", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-activity-test-${Date.now()}`), {
      recursive: true,
    });
    try {
      const entries = [
        {
          ts: 1775190000,
          sid: "abc123",
          agent: "Claude Code",
          cwd: "/test",
          tool: "Edit",
          target: "src/cli.ts",
          tokens: { in: 1, out: 73, cache: 1000 },
        },
        {
          ts: 1775190005,
          sid: "abc123",
          agent: "Claude Code",
          cwd: "/test",
          tool: "Bash",
          target: "npm test",
          tokens: { in: 2, out: 50, cache: 500 },
        },
      ];
      await appendActivityEntries(dir, "2026-04-03", entries);

      const loaded = await readActivityLog(dir, "2026-04-03");
      assert.equal(loaded.length, 2);
      assert.equal(loaded[0].tool, "Edit");
      assert.equal(loaded[1].tool, "Bash");

      // Append more
      await appendActivityEntries(dir, "2026-04-03", [
        {
          ts: 1775190010,
          sid: "def456",
          agent: "Codex",
          cwd: "/other",
          tool: "Bash",
          target: "git status",
        },
      ]);

      const all = await readActivityLog(dir, "2026-04-03");
      assert.equal(all.length, 3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("cleans up activity logs older than retention days", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-activity-cleanup-${Date.now()}`), {
      recursive: true,
    });
    try {
      await writeFile(join(dir, "2026-03-20.jsonl"), "{}\n");
      await writeFile(join(dir, "2026-03-25.jsonl"), "{}\n");
      await writeFile(join(dir, "2026-04-03.jsonl"), "{}\n");

      const deleted = await cleanupOldActivityLogs(dir, 7, new Date("2026-04-03"));
      assert.equal(deleted, 2);

      const remaining = await readActivityLog(dir, "2026-04-03");
      assert.equal(remaining.length, 1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("does not delete cutoff-day file when called mid-day", async () => {
    const dir = await mkdir(join(tmpdir(), `marmonitor-activity-boundary-${Date.now()}`), {
      recursive: true,
    });
    try {
      await writeFile(join(dir, "2026-03-27.jsonl"), "{}\n");
      await writeFile(join(dir, "2026-03-28.jsonl"), "{}\n");
      await writeFile(join(dir, "2026-04-03.jsonl"), "{}\n");

      // 7 days from Apr 3 23:59 = Mar 27 23:59 cutoff
      // Mar 27 should be kept (cutoff day itself), Mar 26 and older should be deleted
      const deleted = await cleanupOldActivityLogs(dir, 7, new Date("2026-04-03T23:59:00"));
      assert.equal(deleted, 0); // Mar 27 and later should all be kept
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("formats date keys using local calendar date", () => {
    const date = new Date(2026, 3, 3, 23, 59, 0);
    assert.equal(formatDateKey(date), "2026-04-03");
  });

  it("returns recent local date keys in descending order", () => {
    const keys = getRecentDateKeys(3, new Date(2026, 3, 3, 23, 59, 0));
    assert.deepEqual(keys, ["2026-04-03", "2026-04-02", "2026-04-01"]);
  });
});

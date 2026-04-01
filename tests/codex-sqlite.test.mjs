import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { indexCodexSessionsFromSqlite } from "../dist/scanner/codex-sqlite.js";

describe("codex sqlite indexing", () => {
  it("indexes active threads from sqlite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-codex-sqlite-"));
    const dbPath = join(dir, "state.sqlite");
    const jsonlPath = join(dir, "rollout.jsonl");
    try {
      // Create a minimal SQLite DB with threads table
      execSync(`sqlite3 "${dbPath}" "
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'cli',
          model_provider TEXT NOT NULL DEFAULT 'openai',
          cwd TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          sandbox_policy TEXT NOT NULL DEFAULT '{}',
          approval_mode TEXT NOT NULL DEFAULT 'on-request',
          tokens_used INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          cli_version TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, tokens_used, archived, model)
        VALUES ('test-session-1', '${jsonlPath}', 1774000000, 1775000000, '/projects/test', 12345, 0, 'gpt-5.4');
        INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, tokens_used, archived, model)
        VALUES ('test-session-2', '/nonexistent.jsonl', 1774000000, 1774500000, '/projects/other', 999, 1, 'gpt-5.4');
      "`);

      // Create a dummy JSONL file
      await writeFile(jsonlPath, '{"type":"session_meta"}\n', "utf-8");

      const sessions = await indexCodexSessionsFromSqlite(dbPath);

      // Should only return non-archived sessions
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, "test-session-1");
      assert.equal(sessions[0].cwd, "/projects/test");
      assert.equal(sessions[0].filePath, jsonlPath);
      assert.equal(sessions[0].model, "gpt-5.4");
      assert.ok(sessions[0].timestamp > 0);
      assert.ok(sessions[0].lastActivityAt > 0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns empty array when sqlite3 is not available or DB missing", async () => {
    const sessions = await indexCodexSessionsFromSqlite("/nonexistent/path/state.sqlite");
    assert.equal(sessions.length, 0);
  });

  it("includes tokens_used as totalTokenUsage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "marmonitor-codex-sqlite-"));
    const dbPath = join(dir, "state.sqlite");
    try {
      execSync(`sqlite3 "${dbPath}" "
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'cli',
          model_provider TEXT NOT NULL DEFAULT 'openai',
          cwd TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          sandbox_policy TEXT NOT NULL DEFAULT '{}',
          approval_mode TEXT NOT NULL DEFAULT 'on-request',
          tokens_used INTEGER NOT NULL DEFAULT 0,
          archived INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          cli_version TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, tokens_used, archived, model)
        VALUES ('tok-test', '/tmp/rollout.jsonl', 1774000000, 1775000000, '/test', 500000, 0, 'gpt-5.4');
      "`);

      const sessions = await indexCodexSessionsFromSqlite(dbPath);
      assert.equal(sessions.length, 1);
      assert.ok(sessions[0].totalTokenUsage);
      assert.equal(sessions[0].totalTokenUsage.total_tokens, 500000);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

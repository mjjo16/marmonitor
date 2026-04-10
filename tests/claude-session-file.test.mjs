import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { parseClaudeSession, resolveClaudeSessionFile } from "../dist/scanner/claude.js";
import { claudeProjectDirCache, claudeSessionRegistry } from "../dist/scanner/cache.js";

function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

async function createJsonl(filePath, mtimeSec) {
  await writeFile(filePath, "{}\n", "utf-8");
  const when = new Date(mtimeSec * 1000);
  await utimes(filePath, when, when);
}

describe("resolveClaudeSessionFile", () => {
  it("promotes a provisional binding to direct when the new session file appears", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-direct-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const oldPath = join(projectDir, "old-session.jsonl");
    const directPath = join(projectDir, "new-session.jsonl");

    await mkdir(projectDir, { recursive: true });
    await createJsonl(oldPath, 1_700_000_000);
    await createJsonl(directPath, 1_700_000_600);

    claudeSessionRegistry.set("new-session", {
      filePath: oldPath,
      sessionId: "new-session",
      cwd,
      firstSeenOffset: 0,
      source: "claude",
      binding: "provisional",
    });

    const config = {
      ...getDefaults(),
      paths: {
        ...getDefaults().paths,
        claudeProjects: [projectsRoot],
      },
    };

    try {
      const resolved = await resolveClaudeSessionFile("new-session", cwd, 1_700_000_000, config);
      assert.equal(resolved, directPath);
      assert.equal(claudeSessionRegistry.get("new-session")?.binding, "direct");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the existing provisional binding when no candidate is clearly newer", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-ambiguous-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const provisionalPath = join(projectDir, "old-session.jsonl");
    const candidateA = join(projectDir, "candidate-a.jsonl");
    const candidateB = join(projectDir, "candidate-b.jsonl");

    await mkdir(projectDir, { recursive: true });
    await createJsonl(provisionalPath, 1_700_000_000);
    await createJsonl(candidateA, 1_700_000_060);
    await createJsonl(candidateB, 1_700_000_120);

    claudeSessionRegistry.set("new-session", {
      filePath: provisionalPath,
      sessionId: "new-session",
      cwd,
      firstSeenOffset: 0,
      source: "claude",
      binding: "provisional",
    });

    const config = {
      ...getDefaults(),
      paths: {
        ...getDefaults().paths,
        claudeProjects: [projectsRoot],
      },
    };

    try {
      const resolved = await resolveClaudeSessionFile("new-session", cwd, undefined, config);
      assert.equal(resolved, provisionalPath);
      assert.equal(claudeSessionRegistry.get("new-session")?.filePath, provisionalPath);
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the existing provisional binding for a known session id even when a newer file exists", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-recent-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const provisionalPath = join(projectDir, "old-session.jsonl");
    const recentPath = join(projectDir, "latest-session.jsonl");

    await mkdir(projectDir, { recursive: true });
    await createJsonl(provisionalPath, Math.floor(Date.now() / 1000) - 20 * 60);
    await createJsonl(recentPath, Math.floor(Date.now() / 1000) - 60);

    claudeSessionRegistry.set("new-session", {
      filePath: provisionalPath,
      sessionId: "new-session",
      cwd,
      firstSeenOffset: 0,
      source: "claude",
      binding: "provisional",
    });

    const config = {
      ...getDefaults(),
      paths: {
        ...getDefaults().paths,
        claudeProjects: [projectsRoot],
      },
    };

    try {
      const resolved = await resolveClaudeSessionFile("new-session", cwd, undefined, config);
      assert.equal(resolved, provisionalPath);
      assert.equal(claudeSessionRegistry.get("new-session")?.filePath, provisionalPath);
      assert.equal(claudeSessionRegistry.get("new-session")?.binding, "provisional");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("parseClaudeSession", () => {
  it("overrides stale pid session metadata with the clearly newest project session", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-stale-session-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const sessionsRoot = join(root, "sessions");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const sessionMetaPath = join(sessionsRoot, "39121.json");
    const oldPath = join(projectDir, "old-session.jsonl");
    const newPath = join(projectDir, "new-session.jsonl");

    await mkdir(projectDir, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await createJsonl(oldPath, Math.floor(Date.now() / 1000) - 40 * 60);
    await writeFile(
      newPath,
      [
        JSON.stringify({
          type: "file-history-snapshot",
          snapshot: { timestamp: "2026-04-10T07:25:50.622Z" },
        }),
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: "new-session",
          timestamp: "2026-04-10T07:25:50.622Z",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await utimes(newPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await writeFile(
      sessionMetaPath,
      JSON.stringify({
        pid: 39121,
        sessionId: "old-session",
        cwd,
        startedAt: 1775784665854,
      }),
      "utf-8",
    );

    const defaults = getDefaults();
    const config = {
      ...defaults,
      paths: {
        ...defaults.paths,
        claudeProjects: [projectsRoot],
        claudeSessions: [sessionsRoot],
      },
    };

    try {
      const parsed = await parseClaudeSession(39121, cwd, 1775784665, config);
      assert.equal(parsed.sessionId, "new-session");
      assert.equal(parsed.cwd, cwd);
      assert.equal(claudeSessionRegistry.get("new-session")?.filePath, newPath);
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not override stale pid metadata when the old direct session file is still recently active", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-no-steal-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const sessionsRoot = join(root, "sessions");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const sessionMetaPath = join(sessionsRoot, "39121.json");
    const oldPath = join(projectDir, "old-session.jsonl");
    const newPath = join(projectDir, "new-session.jsonl");
    const nowSec = Math.floor(Date.now() / 1000);

    await mkdir(projectDir, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      oldPath,
      [
        JSON.stringify({ type: "permission-mode", sessionId: "old-session" }),
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: "old-session",
          timestamp: "2026-04-10T08:00:00.000Z",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await utimes(oldPath, new Date((nowSec - 120) * 1000), new Date((nowSec - 120) * 1000));
    await writeFile(
      newPath,
      [
        JSON.stringify({ type: "file-history-snapshot", snapshot: { timestamp: "2026-04-10T08:05:00.000Z" } }),
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: "new-session",
          timestamp: "2026-04-10T08:05:00.000Z",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await utimes(newPath, new Date((nowSec - 60) * 1000), new Date((nowSec - 60) * 1000));
    await writeFile(
      sessionMetaPath,
      JSON.stringify({
        pid: 39121,
        sessionId: "old-session",
        cwd,
        startedAt: 1775784665854,
      }),
      "utf-8",
    );

    const defaults = getDefaults();
    const config = {
      ...defaults,
      paths: {
        ...defaults.paths,
        claudeProjects: [projectsRoot],
        claudeSessions: [sessionsRoot],
      },
    };

    try {
      const parsed = await parseClaudeSession(39121, cwd, 1775784665, config);
      assert.equal(parsed.sessionId, "old-session");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });
});

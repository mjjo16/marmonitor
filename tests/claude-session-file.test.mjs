import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { claudeProjectDirCache, claudeSessionRegistry } from "../dist/scanner/cache.js";
import {
  matchClaudeSessionByMtime,
  parseClaudeSession,
  resolveClaudeSessionFile,
} from "../dist/scanner/claude.js";

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
      `${[
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
      ].join("\n")}\n`,
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
      `${[
        JSON.stringify({ type: "permission-mode", sessionId: "old-session" }),
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: "old-session",
          timestamp: "2026-04-10T08:00:00.000Z",
        }),
      ].join("\n")}\n`,
      "utf-8",
    );
    await utimes(oldPath, new Date((nowSec - 120) * 1000), new Date((nowSec - 120) * 1000));
    await writeFile(
      newPath,
      `${[
        JSON.stringify({
          type: "file-history-snapshot",
          snapshot: { timestamp: "2026-04-10T08:05:00.000Z" },
        }),
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: "new-session",
          timestamp: "2026-04-10T08:05:00.000Z",
        }),
      ].join("\n")}\n`,
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

describe("chooseStaleSessionOverride conservative guards (#103)", () => {
  it("F1: does not misroute dormant same-cwd session to active sibling jsonl", async () => {
    // Reproduces local issue #103 / GH #56 deterministically.
    // Two Claude sessions share cwd. The dormant one (current) has its own
    // jsonl whose first-line timestamp matches its processStartedAt. The
    // active sibling's jsonl is newer by 56min and the dormant's mtime is
    // older than 30min — exactly the case where the legacy mtime check would
    // override. F1 must short-circuit on processStartedAt parity.
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-103-f1-${Date.now()}`);
    const cwd = join(root, "shared");
    const projectsRoot = join(root, "projects");
    const sessionsRoot = join(root, "sessions");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const dormantPid = 48477;
    const sessionMetaPath = join(sessionsRoot, `${dormantPid}.json`);
    const dormantPath = join(projectDir, "abd04dd5.jsonl");
    const activePath = join(projectDir, "048c0eb5.jsonl");
    const nowSec = Math.floor(Date.now() / 1000);
    // Dormant process started 2h ago; its jsonl first-line carries the same
    // creation time (well within F1's clock-skew window).
    const dormantStartedAt = nowSec - 2 * 3600;
    const dormantTs = new Date(dormantStartedAt * 1000).toISOString();
    // Active sibling started 1h ago; its jsonl is the newest in the dir.
    const activeStartedAt = nowSec - 3600;
    const activeTs = new Date(activeStartedAt * 1000).toISOString();

    await mkdir(projectDir, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      dormantPath,
      `${[
        JSON.stringify({ type: "permission-mode", sessionId: "abd04dd5" }),
        JSON.stringify({ type: "user", cwd, sessionId: "abd04dd5", timestamp: dormantTs }),
      ].join("\n")}\n`,
      "utf-8",
    );
    await writeFile(
      activePath,
      `${[
        JSON.stringify({ type: "permission-mode", sessionId: "048c0eb5" }),
        JSON.stringify({ type: "user", cwd, sessionId: "048c0eb5", timestamp: activeTs }),
      ].join("\n")}\n`,
      "utf-8",
    );
    // Dormant jsonl mtime: 1h45m ago (well past 30min staleness window).
    const dormantMtime = new Date((nowSec - 1.75 * 3600) * 1000);
    await utimes(dormantPath, dormantMtime, dormantMtime);
    // Active sibling jsonl mtime: 49min ago — 56min newer than dormant.
    const activeMtime = new Date((nowSec - 49 * 60) * 1000);
    await utimes(activePath, activeMtime, activeMtime);
    await writeFile(
      sessionMetaPath,
      JSON.stringify({
        pid: dormantPid,
        sessionId: "abd04dd5",
        cwd,
        startedAt: dormantStartedAt * 1000,
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
      const parsed = await parseClaudeSession(dormantPid, cwd, dormantStartedAt, config);
      // Without F1, parsed.sessionId would have become "048c0eb5" (the active
      // sibling) — exactly the misrouting reported in #103.
      assert.equal(parsed.sessionId, "abd04dd5");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("F2: does not override onto a sessionId already direct-bound to another live PID", async () => {
    // Even if the dormant jsonl is missing (currentDirectPath undefined, so
    // F1 cannot apply), F2 must still refuse when the active sibling's
    // sessionId already has a direct binding registered.
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-claude-103-f2-${Date.now()}`);
    const cwd = join(root, "shared");
    const projectsRoot = join(root, "projects");
    const sessionsRoot = join(root, "sessions");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const dormantPid = 22222;
    const sessionMetaPath = join(sessionsRoot, `${dormantPid}.json`);
    const activePath = join(projectDir, "active.jsonl");
    const nowSec = Math.floor(Date.now() / 1000);
    const activeTs = new Date((nowSec - 60) * 1000).toISOString();

    await mkdir(projectDir, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    // No dormant jsonl on disk (dormant sessionId points to a missing file).
    await writeFile(
      activePath,
      `${[
        JSON.stringify({ type: "permission-mode", sessionId: "active" }),
        JSON.stringify({ type: "user", cwd, sessionId: "active", timestamp: activeTs }),
      ].join("\n")}\n`,
      "utf-8",
    );
    await writeFile(
      sessionMetaPath,
      JSON.stringify({
        pid: dormantPid,
        sessionId: "dormant",
        cwd,
        startedAt: (nowSec - 3600) * 1000,
      }),
      "utf-8",
    );

    // Simulate another live PID already holding the active jsonl direct-bound.
    claudeSessionRegistry.set("active", {
      filePath: activePath,
      sessionId: "active",
      cwd,
      firstSeenOffset: 0,
      startedAt: nowSec - 60,
      source: "claude",
      binding: "direct",
    });

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
      const parsed = await parseClaudeSession(dormantPid, cwd, nowSec - 3600, config);
      // Override blocked by F2 → dormant session keeps its (stale) sessionId,
      // which is the conservative outcome ("unresolved is safer than misrouted").
      assert.equal(parsed.sessionId, "dormant");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("matchClaudeSessionByMtime", () => {
  it("returns undefined when two files have timestamps within 5 minutes of each other (ambiguous)", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-mtime-ambiguous-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const pathA = join(projectDir, "session-a.jsonl");
    const pathB = join(projectDir, "session-b.jsonl");

    await mkdir(projectDir, { recursive: true });

    const nowMs = Date.now();
    // Two files only 2 minutes apart — ambiguous, should not pick either
    const mtimeA = nowMs - 2 * 60 * 1000;
    const mtimeB = nowMs;

    await writeFile(pathA, "{}\n", "utf-8");
    await utimes(pathA, new Date(mtimeA), new Date(mtimeA));
    await writeFile(pathB, "{}\n", "utf-8");
    await utimes(pathB, new Date(mtimeB), new Date(mtimeB));

    const defaults = getDefaults();
    const config = {
      ...defaults,
      paths: { ...defaults.paths, claudeProjects: [projectsRoot] },
    };

    try {
      // No processStartedAt → falls into else-branch conservative check
      const result = await matchClaudeSessionByMtime(cwd, undefined, config);
      assert.equal(result, undefined, "should return undefined for ambiguous mtime pair");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the clearly newest file when it leads by more than 5 minutes", async () => {
    claudeSessionRegistry.clear();
    claudeProjectDirCache.clear();

    const root = join(tmpdir(), `marmonitor-mtime-clear-${Date.now()}`);
    const cwd = join(root, "repo");
    const projectsRoot = join(root, "projects");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const oldPath = join(projectDir, "old-session.jsonl");
    const newPath = join(projectDir, "new-session.jsonl");

    await mkdir(projectDir, { recursive: true });

    const nowMs = Date.now();
    const mtimeOld = nowMs - 30 * 60 * 1000; // 30 min ago
    const mtimeNew = nowMs - 1 * 60 * 1000; // 1 min ago — leads by 29 min

    // Old file with no parseable sessionId
    await writeFile(oldPath, "{}\n", "utf-8");
    await utimes(oldPath, new Date(mtimeOld), new Date(mtimeOld));

    // New file with proper sessionId in first line
    await writeFile(
      newPath,
      `${JSON.stringify({ type: "user", cwd, sessionId: "new-session", timestamp: new Date(mtimeNew).toISOString() })}\n`,
      "utf-8",
    );
    await utimes(newPath, new Date(mtimeNew), new Date(mtimeNew));

    const defaults = getDefaults();
    const config = {
      ...defaults,
      paths: { ...defaults.paths, claudeProjects: [projectsRoot] },
    };

    try {
      const result = await matchClaudeSessionByMtime(cwd, undefined, config);
      assert.equal(result?.sessionId, "new-session");
    } finally {
      claudeSessionRegistry.clear();
      claudeProjectDirCache.clear();
      await rm(root, { recursive: true, force: true });
    }
  });
});

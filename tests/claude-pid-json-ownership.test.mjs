/**
 * Regression tests for local issue #107 — pid.json ownership via `procStart`.
 *
 * Claude Code records `procStart` in ~/.claude/sessions/<pid>.json as a UTC
 * calendar string. Measured against `ps -o lstart=` on every live session it
 * names the same instant to the second, which makes it a decisive answer to
 * "was this file written by the process currently holding this PID?".
 *
 * Verified live before writing these: running /clear in a session left the PID
 * and `procStart` untouched while rewriting `sessionId` to the new session and
 * creating its jsonl 34 minutes after process start. The mtime heuristic
 * picked the *abandoned* pre-clear session for that PID (its first entry sits
 * 1s from lstart), while pid.json named the live one. That is the shape these
 * fixtures reproduce.
 */
import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { claudeProjectDirCache, claudeSessionRegistry } from "../dist/scanner/cache.js";
import {
  classifyClaudePidJsonOwnership,
  parseClaudePidJsonProcStart,
  parseClaudeSession,
} from "../dist/scanner/claude.js";

const encodeProjectDir = (cwd) => cwd.replace(/[/.]/g, "-");
const clearCaches = () => {
  claudeSessionRegistry.clear();
  claudeProjectDirCache.clear();
};

/** Render an epoch as the UTC calendar string Claude Code writes. */
function toProcStart(epochSec) {
  return new Date(epochSec * 1000)
    .toUTCString()
    .replace(/^(\w+), (\d+) (\w+) (\d+) (.+) GMT$/, "$1 $3 $2 $4 $5");
}

function jsonlLine(sessionId, cwd, isoTs) {
  return `${JSON.stringify({ parentUuid: null, sessionId, cwd, timestamp: isoTs, type: "user", message: { content: "hi" } })}\n`;
}

/**
 * cwd with a "current" session whose jsonl predates the process (a resumed
 * conversation, so guard F1 cannot vouch for it) and a fresher sibling that
 * the stale override would rather pick.
 */
async function setupStaleShapedFixture({ pid, procStart, currentSessionId, siblingSessionId }) {
  const root = join(tmpdir(), `marm-107-${pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const cwd = join(root, "work");
  const projectsRoot = join(root, "projects");
  const sessionsRoot = join(root, "sessions");
  const projectDir = join(projectsRoot, encodeProjectDir(cwd));
  await mkdir(projectDir, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });

  const nowSec = Math.floor(Date.now() / 1000);
  const processStartedAt = nowSec - 4 * 3600;

  const currentPath = join(projectDir, `${currentSessionId}.jsonl`);
  await writeFile(
    currentPath,
    jsonlLine(currentSessionId, cwd, new Date((processStartedAt - 3 * 3600) * 1000).toISOString()),
    "utf-8",
  );
  // Untouched for over an hour, so the override's staleGap/minLead both pass.
  await utimes(currentPath, nowSec - 3600, nowSec - 3600);

  const siblingPath = join(projectDir, `${siblingSessionId}.jsonl`);
  await writeFile(
    siblingPath,
    jsonlLine(siblingSessionId, cwd, new Date((nowSec - 600) * 1000).toISOString()),
    "utf-8",
  );
  await utimes(siblingPath, nowSec - 60, nowSec - 60);

  await writeFile(
    join(sessionsRoot, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: currentSessionId,
      cwd,
      startedAt: processStartedAt * 1000,
      ...(procStart === null ? {} : { procStart: procStart ?? toProcStart(processStartedAt) }),
    }),
    "utf-8",
  );

  const defaults = getDefaults();
  return {
    root,
    cwd,
    processStartedAt,
    config: {
      ...defaults,
      paths: { ...defaults.paths, claudeProjects: [projectsRoot], claudeSessions: [sessionsRoot] },
    },
  };
}

describe("parseClaudePidJsonProcStart (#107)", () => {
  it("reads the recorded string as UTC, not local time", () => {
    const parsed = parseClaudePidJsonProcStart("Mon Aug 17 05:43:19 2026");
    assert.equal(parsed, Date.UTC(2026, 7, 17, 5, 43, 19) / 1000);
  });

  it("round-trips a real process start", () => {
    const epoch = Math.floor(Date.UTC(2026, 7, 17, 5, 12, 18) / 1000);
    assert.equal(parseClaudePidJsonProcStart(toProcStart(epoch)), epoch);
  });

  it("returns undefined for missing or unparseable values", () => {
    for (const bad of [undefined, null, "", "   ", 12345, "not a date"]) {
      assert.equal(parseClaudePidJsonProcStart(bad), undefined, String(bad));
    }
  });
});

describe("classifyClaudePidJsonOwnership (#107)", () => {
  const epoch = Math.floor(Date.UTC(2026, 7, 17, 5, 43, 19) / 1000);
  const procStart = toProcStart(epoch);

  it("calls it owned when procStart matches the live start time", () => {
    assert.equal(classifyClaudePidJsonOwnership(procStart, epoch), "owned");
  });

  it("absorbs the one-second rendering precision on both sides", () => {
    assert.equal(classifyClaudePidJsonOwnership(procStart, epoch + 1), "owned");
    assert.equal(classifyClaudePidJsonOwnership(procStart, epoch - 1), "owned");
  });

  it("calls it recycled when the live process started at a different time", () => {
    assert.equal(classifyClaudePidJsonOwnership(procStart, epoch + 600), "recycled");
  });

  it("stays unknown when either side is missing", () => {
    // Older Claude Code builds write no procStart; `ps` can also fail.
    assert.equal(classifyClaudePidJsonOwnership(undefined, epoch), "unknown");
    assert.equal(classifyClaudePidJsonOwnership(procStart, undefined), "unknown");
    assert.equal(classifyClaudePidJsonOwnership(procStart, Number.NaN), "unknown");
  });
});

describe("parseClaudeSession honours pid.json ownership (#107)", () => {
  it("keeps the recorded session when procStart proves the file is ours", async () => {
    // Without the ownership check the stale override fires here: the current
    // jsonl predates the process (resumed conversation) so F1 cannot vouch for
    // it, it has been idle long enough to look stale, and the sibling leads it
    // by mtime. The override would hand this PID the sibling's session.
    clearCaches();
    const current = "c0000000-1111-2222-3333-c00000001111";
    const sibling = "5b100000-1111-2222-3333-5b1000001111";
    const fx = await setupStaleShapedFixture({
      pid: 4101,
      currentSessionId: current,
      siblingSessionId: sibling,
    });
    try {
      const parsed = await parseClaudeSession(
        4101,
        fx.cwd,
        fx.processStartedAt,
        fx.config,
        new Set(),
      );
      assert.equal(parsed.sessionId, current, "authoritative pid.json must win over the override");
    } finally {
      clearCaches();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("still consults the override when the build wrote no procStart", async () => {
    clearCaches();
    const current = "c0000000-1111-2222-3333-c00000002222";
    const sibling = "5b100000-1111-2222-3333-5b1000002222";
    const fx = await setupStaleShapedFixture({
      pid: 4102,
      procStart: null,
      currentSessionId: current,
      siblingSessionId: sibling,
    });
    try {
      const parsed = await parseClaudeSession(
        4102,
        fx.cwd,
        fx.processStartedAt,
        fx.config,
        new Set(),
      );
      assert.equal(parsed.sessionId, sibling, "unknown ownership must keep the previous behaviour");
    } finally {
      clearCaches();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("discards a pid.json left behind by a recycled PID", async () => {
    clearCaches();
    const current = "c0000000-1111-2222-3333-c00000003333";
    const sibling = "5b100000-1111-2222-3333-5b1000003333";
    const fx = await setupStaleShapedFixture({
      pid: 4103,
      currentSessionId: current,
      siblingSessionId: sibling,
    });
    try {
      // The live process started an hour after whatever wrote the file, so the
      // record describes a dead process that happened to hold this PID.
      const parsed = await parseClaudeSession(
        4103,
        fx.cwd,
        fx.processStartedAt + 3600,
        fx.config,
        new Set(),
      );
      assert.notEqual(
        parsed.sessionId,
        current,
        "a recycled PID must not inherit the dead process's sessionId",
      );
    } finally {
      clearCaches();
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports when the conversation began, not when the CLI process did", async () => {
    // /clear starts a new sessionId inside a long-running process. pid.json's
    // startedAt still points at process start, so it must not be used verbatim.
    clearCaches();
    const current = "c0000000-1111-2222-3333-c00000004444";
    const sibling = "5b100000-1111-2222-3333-5b1000004444";
    const fx = await setupStaleShapedFixture({
      pid: 4104,
      currentSessionId: current,
      siblingSessionId: sibling,
    });
    try {
      const parsed = await parseClaudeSession(
        4104,
        fx.cwd,
        fx.processStartedAt,
        fx.config,
        new Set(),
      );
      assert.equal(parsed.sessionId, current);
      // The fixture's current jsonl opens three hours before process start.
      assert.ok(
        parsed.startedAt !== undefined && parsed.startedAt < fx.processStartedAt,
        `startedAt ${parsed.startedAt} should come from the jsonl, not pid.json (${fx.processStartedAt})`,
      );
    } finally {
      clearCaches();
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});

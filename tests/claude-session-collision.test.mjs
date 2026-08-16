/**
 * Regression tests for local issue #108 — same-cwd Claude collision.
 *
 * Reproduces the 4 collision patterns we verified by direct repro:
 *   1. Two processes with clearly separated lstart values → each binds to its
 *      own jsonl (happy path; must keep working).
 *   2. Two processes with the same lstart (1-sec ps precision) → neither
 *      should bind, because a tiebreaker would land both on the same sessionId
 *      in the daemon snapshot.
 *   3. Process A's first jsonl message lags ≥30s behind its lstart while a
 *      sibling jsonl is fresh → match must refuse rather than misroute to the
 *      sibling. This is the exact mechanism behind the user-reported
 *      "prefix+y copied the other pane's turn".
 *   4. Two jsonls authored <1s apart → match must refuse (gap below the
 *      dominance threshold).
 *
 * Also covers the orchestration-level invariant: a sessionId already claimed
 * by another PID in the same scan cycle is excluded from the candidate pool.
 */
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { claudeProjectDirCache, claudeSessionRegistry } from "../dist/scanner/cache.js";
import {
  matchClaudeSessionByMtime,
  matchClaudeSessionsByMtime,
  parseClaudeSession,
} from "../dist/scanner/claude.js";

function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

function buildJsonl(sessionId, cwd, isoTs) {
  return `${JSON.stringify({
    parentUuid: null,
    sessionId,
    cwd,
    timestamp: isoTs,
    type: "user",
    message: { content: "hi" },
  })}\n`;
}

function makeConfig(projectsRoot) {
  const defaults = getDefaults();
  return {
    ...defaults,
    paths: { ...defaults.paths, claudeProjects: [projectsRoot] },
  };
}

async function setupTwoSessions(root, cwd, sessions) {
  const projectsRoot = join(root, "projects");
  const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
  await mkdir(projectDir, { recursive: true });
  for (const { sessionId, isoTs } of sessions) {
    await writeFile(
      join(projectDir, `${sessionId}.jsonl`),
      buildJsonl(sessionId, cwd, isoTs),
      "utf-8",
    );
  }
  return projectsRoot;
}

function clearAllCaches() {
  claudeSessionRegistry.clear();
  claudeProjectDirCache.clear();
}

describe("matchClaudeSessionByMtime — same-cwd collision (#108)", () => {
  it("scenario 1: clearly separated lstart values → each PID binds to its own jsonl", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-s1-${Date.now()}`);
    const cwd = join(root, "shared");
    const sidA = "11111111-aaaa-aaaa-aaaa-111111111111";
    const sidB = "22222222-bbbb-bbbb-bbbb-222222222222";
    const tsA = "2026-05-27T10:00:00.000Z";
    const tsB = "2026-05-27T10:05:00.000Z"; // 5 minutes apart — clearly separated
    const projectsRoot = await setupTwoSessions(root, cwd, [
      { sessionId: sidA, isoTs: tsA },
      { sessionId: sidB, isoTs: tsB },
    ]);
    const config = makeConfig(projectsRoot);
    const epochA = new Date(tsA).getTime() / 1000;
    const epochB = new Date(tsB).getTime() / 1000;
    try {
      const r1 = await matchClaudeSessionByMtime(cwd, epochA, config);
      const r2 = await matchClaudeSessionByMtime(cwd, epochB, config);
      assert.equal(r1?.sessionId, sidA, "proc_A lstart=tsA → sidA");
      assert.equal(r2?.sessionId, sidB, "proc_B lstart=tsB → sidB");

      const batch = await matchClaudeSessionsByMtime(
        [
          { pid: 101, cwd, processStartedAt: epochA },
          { pid: 102, cwd, processStartedAt: epochB },
        ],
        config,
      );
      assert.equal(batch.get(101)?.sessionId, sidA);
      assert.equal(batch.get(102)?.sessionId, sidB);
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scenario 2: same-second lstart (ps precision) → no PID gets a binding", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-s2-${Date.now()}`);
    const cwd = join(root, "shared");
    const sidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sidB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const tsA = "2026-05-27T10:00:00.000Z";
    const tsB = "2026-05-27T10:00:01.000Z"; // <1s apart → gap below threshold
    const projectsRoot = await setupTwoSessions(root, cwd, [
      { sessionId: sidA, isoTs: tsA },
      { sessionId: sidB, isoTs: tsB },
    ]);
    const config = makeConfig(projectsRoot);
    const sameEpoch = new Date(tsA).getTime() / 1000;
    try {
      const r1 = await matchClaudeSessionByMtime(cwd, sameEpoch, config);
      const r2 = await matchClaudeSessionByMtime(cwd, sameEpoch, config);
      assert.equal(r1, undefined, "call #1 must refuse when gap is too small");
      assert.equal(r2, undefined, "call #2 must refuse when gap is too small");
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scenario 3: proc_A first message delayed 30s → orchestration cycle-claim refuses misroute", async () => {
    // Scenario 3 (the user-reported bug) is *not* solvable by single-call
    // dual threshold alone — proc_A sees sidB at 1s and sidA at 30s, so the
    // closest+dominant winner is the sibling jsonl. The match returns sidB
    // from proc_A's perspective in isolation, which is exactly the
    // misrouting. The fix is the cycle-local claim Set the orchestration
    // builds: once proc_B is bound to sidB in the same scan cycle, sidB is
    // excluded from proc_A's candidate pool — leaving only sidA whose
    // deltaSec=30s exceeds the top threshold → proc_A stays unbound (safer
    // than misrouting). This test models the cycle as the daemon would.
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-s3-${Date.now()}`);
    const cwd = join(root, "shared");
    const sidA = "33333333-aaaa-aaaa-aaaa-333333333333";
    const sidB = "44444444-bbbb-bbbb-bbbb-444444444444";
    const tsAlate = "2026-05-27T10:00:30.000Z"; // proc_A first msg lags 30s
    const tsBfresh = "2026-05-27T10:00:01.000Z"; // proc_B msg at T+1s
    const projectsRoot = await setupTwoSessions(root, cwd, [
      { sessionId: sidA, isoTs: tsAlate },
      { sessionId: sidB, isoTs: tsBfresh },
    ]);
    const config = makeConfig(projectsRoot);
    const procAEpoch = new Date("2026-05-27T10:00:00.000Z").getTime() / 1000;
    const procBEpoch = new Date("2026-05-27T10:00:00.000Z").getTime() / 1000 + 1;
    try {
      const claimed = new Set();
      // Cycle step 1: proc_B matches first (closest to its lstart) → sidB.
      const rB = await matchClaudeSessionByMtime(cwd, procBEpoch, config, claimed);
      assert.equal(rB?.sessionId, sidB, "proc_B should bind sidB");
      if (rB?.sessionId) claimed.add(rB.sessionId);
      // Cycle step 2: proc_A — sidB excluded by claim, only sidA left with
      // deltaSec=30s which exceeds CLAUDE_MATCH_TOP_DELTA_SEC → unbound.
      const rA = await matchClaudeSessionByMtime(cwd, procAEpoch, config, claimed);
      assert.equal(rA, undefined, "proc_A must stay unbound rather than misroute to sidB");
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scenario 3: batch matching is input-order independent and refuses both ambiguous owners", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-s3-batch-${Date.now()}`);
    const cwd = join(root, "shared");
    const sidA = "33333333-aaaa-aaaa-aaaa-333333333333";
    const sidB = "44444444-bbbb-bbbb-bbbb-444444444444";
    const projectsRoot = await setupTwoSessions(root, cwd, [
      { sessionId: sidA, isoTs: "2026-05-27T10:00:30.000Z" },
      { sessionId: sidB, isoTs: "2026-05-27T10:00:01.000Z" },
    ]);
    const config = makeConfig(projectsRoot);
    const requests = [
      { pid: 101, cwd, processStartedAt: new Date("2026-05-27T10:00:00.000Z").getTime() / 1000 },
      { pid: 102, cwd, processStartedAt: new Date("2026-05-27T10:00:01.000Z").getTime() / 1000 },
    ];

    try {
      const forward = await matchClaudeSessionsByMtime(requests, config);
      const reverse = await matchClaudeSessionsByMtime([...requests].reverse(), config);
      // sidB is only one second closer to PID 102 than PID 101. With
      // lstart's one-second precision that is insufficient evidence to assign
      // either owner, so the result must be safely identical in either order.
      assert.equal(forward.size, 0);
      assert.equal(reverse.size, 0);
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("scenario 4: two jsonls <1s apart → refuse (gap below dominance threshold)", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-s4-${Date.now()}`);
    const cwd = join(root, "shared");
    const sidA = "55555555-aaaa-aaaa-aaaa-555555555555";
    const sidB = "66666666-bbbb-bbbb-bbbb-666666666666";
    const tsA = "2026-05-27T10:00:00.500Z";
    const tsB = "2026-05-27T10:00:00.700Z"; // 200ms apart
    const projectsRoot = await setupTwoSessions(root, cwd, [
      { sessionId: sidA, isoTs: tsA },
      { sessionId: sidB, isoTs: tsB },
    ]);
    const config = makeConfig(projectsRoot);
    const procEpoch = new Date(tsA).getTime() / 1000;
    try {
      const r = await matchClaudeSessionByMtime(cwd, procEpoch, config);
      // top.deltaSec≈0, second.deltaSec≈0.2 → gap=0.2s < CLAUDE_MATCH_GAP_SEC (5s).
      assert.equal(r, undefined, "must refuse when runner-up gap < CLAUDE_MATCH_GAP_SEC");
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cycle-claim: a sessionId claimed by an earlier PID in the same scan cycle is excluded", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-claim-${Date.now()}`);
    const cwd = join(root, "shared");
    const sidA = "77777777-aaaa-aaaa-aaaa-777777777777";
    const sidB = "88888888-bbbb-bbbb-bbbb-888888888888";
    // Two clearly-separated sessions. proc_A naturally binds to sidA.
    // proc_B's lstart happens to also be close to sidA's timestamp (e.g. ps
    // precision swallowed the gap). Without the cycle-claim guard, both
    // would race for sidA. With the guard, proc_B sees sidA already taken
    // and binds to sidB instead.
    const tsA = "2026-05-27T10:00:00.000Z";
    const tsB = "2026-05-27T10:10:00.000Z"; // 10 minutes apart
    const projectsRoot = await setupTwoSessions(root, cwd, [
      { sessionId: sidA, isoTs: tsA },
      { sessionId: sidB, isoTs: tsB },
    ]);
    const config = makeConfig(projectsRoot);
    const epochA = new Date(tsA).getTime() / 1000;
    try {
      const claimed = new Set();
      const r1 = await matchClaudeSessionByMtime(cwd, epochA, config, claimed);
      assert.equal(r1?.sessionId, sidA, "proc_A binds to sidA");
      if (r1?.sessionId) claimed.add(r1.sessionId);
      // proc_B's lstart is tsA-ish too — without the claim guard it would
      // also bind to sidA. With the guard sidA is excluded, leaving only
      // sidB (deltaSec=600s — too far to bind even by itself).
      const r2 = await matchClaudeSessionByMtime(cwd, epochA, config, claimed);
      assert.notEqual(r2?.sessionId, sidA, "proc_B must not collapse onto sidA");
      // proc_B winds up unbound here (sidB is 10min away from epochA, beyond
      // the top threshold) — that is the correct conservative outcome.
      assert.equal(r2, undefined, "proc_B unbound is preferred over misrouting");
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("legacy PID metadata refuses a sessionId already claimed by another PID", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-legacy-claim-${Date.now()}`);
    const cwd = join(root, "shared");
    const sessionsRoot = join(root, "sessions");
    const sessionId = "99999999-aaaa-aaaa-aaaa-999999999999";
    const startedAt = Math.floor(Date.now() / 1000);
    await mkdir(sessionsRoot, { recursive: true });
    await Promise.all(
      [101, 102].map((pid) =>
        writeFile(
          join(sessionsRoot, `${pid}.json`),
          JSON.stringify({ pid, cwd, sessionId, startedAt: startedAt * 1000 }),
          "utf-8",
        ),
      ),
    );
    const defaults = getDefaults();
    const config = {
      ...defaults,
      paths: { ...defaults.paths, claudeProjects: [], claudeSessions: [sessionsRoot] },
    };

    try {
      const claimed = new Set();
      const first = await parseClaudeSession(101, cwd, startedAt, config, claimed);
      assert.equal(first.sessionId, sessionId);
      claimed.add(sessionId);
      const second = await parseClaudeSession(102, cwd, startedAt, config, claimed);
      assert.equal(second.sessionId, undefined, "duplicate legacy PID must stay unbound");
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("legacy stale override does not steal a sibling's reserved mtime match", async () => {
    clearAllCaches();
    const root = join(tmpdir(), `marm-collision-legacy-reserved-${Date.now()}`);
    const cwd = join(root, "shared");
    const projectsRoot = join(root, "projects");
    const sessionsRoot = join(root, "sessions");
    const projectDir = join(projectsRoot, encodeClaudeProjectDir(cwd));
    const dormantPid = 101;
    const nowSec = Math.floor(Date.now() / 1000);
    await mkdir(projectDir, { recursive: true });
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      join(projectDir, "active.jsonl"),
      buildJsonl("active", cwd, new Date((nowSec - 10) * 1000).toISOString()),
      "utf-8",
    );
    await writeFile(
      join(sessionsRoot, `${dormantPid}.json`),
      JSON.stringify({
        pid: dormantPid,
        cwd,
        sessionId: "dormant",
        startedAt: (nowSec - 3600) * 1000,
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
      const parsed = await parseClaudeSession(
        dormantPid,
        cwd,
        nowSec - 3600,
        config,
        new Set(),
        undefined,
        new Set(["active"]),
      );
      assert.equal(parsed.sessionId, "dormant", "must not override to sibling's reserved session");
    } finally {
      clearAllCaches();
      await rm(root, { recursive: true, force: true });
    }
  });
});

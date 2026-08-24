/**
 * Regression tests for local issue #113 — the Codex busy inference used to
 * never expire.
 *
 * Measured on a live session before the fix: every Codex-side source said the
 * session last changed on 08-14 (rollout mtime, sqlite `updated_at`,
 * `recency_at`, output tokens 0), while marmonitor reported 08-24 — ten days
 * newer than any real signal. The value came from marmonitor itself: a CPU/
 * phase inference stamped `now`, then four monotonic `Math.max` merges plus
 * `session-registry.json` made it permanent.
 *
 * #090 introduced that inference deliberately, so `last activity` would not
 * snap back to the old rollout mtime the moment a tool finished. The fix keeps
 * that behaviour inside a TTL and drops the inference afterwards.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CODEX_INFERRED_BUSY_TTL_SEC } from "../dist/scanner/cache.js";
import { propagateWorkerStateToParent } from "../dist/scanner/group.js";
import {
  clampRegistryActivityToObserved,
  updateRegistry,
} from "../dist/scanner/session-registry.js";
import {
  isInferredBusyFresh,
  mergeObservedActivityAt,
  resolveCodexInferredBusyAt,
  resolveEffectiveActivityAt,
} from "../dist/scanner/status.js";

const OBSERVED = 1786717290; // 2026-08-14 23:21:30 — real rollout mtime
const NOW = OBSERVED + 10 * 24 * 3600; // ten days later, as in the live report

describe("resolveEffectiveActivityAt (#113)", () => {
  it("prefers a fresh inference over an older observation", () => {
    // #090's case: a tool just finished and the rollout mtime still lags.
    const inferred = NOW - 5;
    assert.equal(resolveEffectiveActivityAt(OBSERVED, inferred, NOW), inferred);
  });

  it("keeps the inference for the whole TTL", () => {
    const inferred = NOW - CODEX_INFERRED_BUSY_TTL_SEC;
    assert.equal(resolveEffectiveActivityAt(OBSERVED, inferred, NOW), inferred);
  });

  it("drops an expired inference and falls back to the observation", () => {
    const inferred = NOW - CODEX_INFERRED_BUSY_TTL_SEC - 1;
    assert.equal(resolveEffectiveActivityAt(OBSERVED, inferred, NOW), OBSERVED);
  });

  it("does not let a stale stamp survive for days", () => {
    // The exact shape of the report: stamped once, quiet ever since.
    const stampedOnce = NOW - 10 * 24 * 3600 + 60;
    assert.equal(resolveEffectiveActivityAt(OBSERVED, stampedOnce, NOW), OBSERVED);
  });

  it("never reports an inference newer than now", () => {
    const effective = resolveEffectiveActivityAt(OBSERVED, NOW, NOW);
    assert.ok(effective !== undefined && effective <= NOW);
  });

  it("returns undefined when there is neither observation nor inference", () => {
    assert.equal(resolveEffectiveActivityAt(undefined, undefined, NOW), undefined);
  });

  it("still reports an observation when nothing looks busy", () => {
    assert.equal(resolveEffectiveActivityAt(OBSERVED, undefined, NOW), OBSERVED);
  });
});

describe("session registry persists observed activity only (#113)", () => {
  const base = {
    pid: 87824,
    agentName: "Codex",
    cwd: "/Users/x/.ai/projects/tossbank",
    sessionId: "019ffff2-5589-7ad2-b294-3a2024659287",
    startedAt: OBSERVED - 12000,
  };

  it("does not write the busy inference to disk", () => {
    const registry = new Map();
    // What the scanner emits mid-burst: effective time is the inference.
    updateRegistry(registry, [
      { ...base, lastActivityAt: NOW, observedActivityAt: OBSERVED, inferredBusyAt: NOW },
    ]);
    assert.equal(registry.get(base.sessionId).lastActivityAt, OBSERVED);
  });

  it("does not ratchet an inference in on a later update", () => {
    const registry = new Map();
    updateRegistry(registry, [{ ...base, lastActivityAt: OBSERVED, observedActivityAt: OBSERVED }]);
    updateRegistry(registry, [
      { ...base, lastActivityAt: NOW, observedActivityAt: OBSERVED, inferredBusyAt: NOW },
    ]);
    assert.equal(
      registry.get(base.sessionId).lastActivityAt,
      OBSERVED,
      "an inferred stamp must not become permanent on disk",
    );
  });

  it("still advances when the observation itself moves forward", () => {
    const registry = new Map();
    updateRegistry(registry, [{ ...base, lastActivityAt: OBSERVED, observedActivityAt: OBSERVED }]);
    const later = OBSERVED + 3600;
    updateRegistry(registry, [{ ...base, lastActivityAt: later, observedActivityAt: later }]);
    assert.equal(registry.get(base.sessionId).lastActivityAt, later);
  });

  it("falls back to lastActivityAt for agents that report no observed field", () => {
    const registry = new Map();
    updateRegistry(registry, [{ ...base, agentName: "Claude Code", lastActivityAt: OBSERVED }]);
    assert.equal(registry.get(base.sessionId).lastActivityAt, OBSERVED);
  });
});

describe("resolveCodexInferredBusyAt (#113)", () => {
  it("is Codex-only", () => {
    for (const agent of ["Claude Code", "Gemini", undefined]) {
      assert.equal(
        resolveCodexInferredBusyAt(9, "tool", 0.5, agent, NOW),
        undefined,
        String(agent),
      );
    }
  });

  it("stamps on a CPU burst or an active phase", () => {
    assert.equal(resolveCodexInferredBusyAt(0.6, undefined, 0.5, "Codex", NOW), NOW);
    for (const phase of ["permission", "thinking", "tool"]) {
      assert.equal(resolveCodexInferredBusyAt(0, phase, 0.5, "Codex", NOW), NOW, phase);
    }
  });

  it("stamps nothing for a quiet process", () => {
    assert.equal(resolveCodexInferredBusyAt(0, "done", 0.5, "Codex", NOW), undefined);
    assert.equal(resolveCodexInferredBusyAt(0.5, undefined, 0.5, "Codex", NOW), undefined);
  });
});

describe("clampRegistryActivityToObserved (#113)", () => {
  async function withJsonl(mtimeSec, run) {
    const root = join(tmpdir(), `marm-113-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    await mkdir(root, { recursive: true });
    const jsonlPath = join(root, "rollout.jsonl");
    await writeFile(jsonlPath, "{}\n", "utf-8");
    await utimes(jsonlPath, mtimeSec, mtimeSec);
    try {
      await run(jsonlPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const record = (jsonlPath, lastActivityAt) => ({
    sessionId: "s1",
    agent: "Codex",
    cwd: "/tmp/x",
    history: [{ pid: 1, jsonlPath, startedAt: OBSERVED - 100 }],
    totalTokens: { input: 0, output: 0, cache: 0 },
    lastActivityAt,
  });

  it("pulls a stamp that outran the file back to the file's mtime", async () => {
    // Exactly the state found on disk: stored ten days past the rollout mtime.
    await withJsonl(OBSERVED, async (jsonlPath) => {
      const registry = new Map([["s1", record(jsonlPath, NOW)]]);
      assert.equal(await clampRegistryActivityToObserved(registry), 1);
      assert.equal(registry.get("s1").lastActivityAt, OBSERVED);
    });
  });

  it("leaves a value the file can justify alone", async () => {
    await withJsonl(NOW, async (jsonlPath) => {
      const registry = new Map([["s1", record(jsonlPath, OBSERVED)]]);
      assert.equal(await clampRegistryActivityToObserved(registry), 0);
      assert.equal(registry.get("s1").lastActivityAt, OBSERVED);
    });
  });

  it("leaves records alone when the file is gone", async () => {
    const registry = new Map([["s1", record("/nonexistent/rollout.jsonl", NOW)]]);
    assert.equal(await clampRegistryActivityToObserved(registry), 0);
    assert.equal(registry.get("s1").lastActivityAt, NOW);
  });

  it("skips records with no jsonl path or no activity time", async () => {
    const noPath = record(undefined, NOW);
    const noActivity = record("/nonexistent/x.jsonl", undefined);
    const registry = new Map([
      ["a", noPath],
      ["b", noActivity],
    ]);
    assert.equal(await clampRegistryActivityToObserved(registry), 0);
    assert.equal(registry.get("a").lastActivityAt, NOW);
    assert.equal(registry.get("b").lastActivityAt, undefined);
  });
});

describe("isInferredBusyFresh (#113)", () => {
  it("is false without a stamp", () => {
    assert.equal(isInferredBusyFresh(undefined, NOW), false);
  });

  it("holds through the last second of the TTL and not past it", () => {
    assert.equal(isInferredBusyFresh(NOW - CODEX_INFERRED_BUSY_TTL_SEC, NOW), true);
    assert.equal(isInferredBusyFresh(NOW - CODEX_INFERRED_BUSY_TTL_SEC - 1, NOW), false);
  });
});

describe("the inference carried across scans (#113)", () => {
  // The TTL is only reachable because scanAgents carries the stamp forward in
  // the enrichment cache. Codex sits at ~0% CPU between bursts, so a stamp that
  // only existed for the scan that made it would expire immediately and snap
  // `last activity` back to the lagging rollout mtime — the #090 regression.
  // This walks the sequence the daemon actually produces: one busy scan, then
  // quiet ones that carry the same stamp.
  const busyAt = NOW;

  it("keeps reporting the burst while quiet scans carry the stamp", () => {
    for (const elapsed of [2, 30, CODEX_INFERRED_BUSY_TTL_SEC]) {
      assert.equal(
        resolveEffectiveActivityAt(OBSERVED, busyAt, busyAt + elapsed),
        busyAt,
        `+${elapsed}s`,
      );
    }
  });

  it("falls back to the rollout mtime once the carried stamp ages out", () => {
    assert.equal(
      resolveEffectiveActivityAt(OBSERVED, busyAt, busyAt + CODEX_INFERRED_BUSY_TTL_SEC + 1),
      OBSERVED,
    );
  });

  it("advances to a real observation that lands during the burst", () => {
    // The rollout file catches up mid-turn: observation wins once it is newer.
    const written = busyAt + 20;
    assert.equal(resolveEffectiveActivityAt(written, busyAt, busyAt + 30), written);
  });
});

describe("daemon activity-collection updates (#113)", () => {
  // daemon-loop's heavy scan pushes a second, differently shaped update into
  // the same registry. It must carry observedActivityAt too, or updateRegistry
  // falls back to the merged lastActivityAt and re-poisons the record.
  const update = {
    agentName: "Codex",
    pid: 87824,
    sessionId: "019ffff2-5589-7ad2-b294-3a2024659287",
    cwd: "/Users/x/.ai/projects/tossbank",
    startedAt: OBSERVED - 12000,
    jsonlPath: "/Users/x/.codex/sessions/rollout.jsonl",
  };

  it("persists the observation, not the merged value", () => {
    const registry = new Map();
    updateRegistry(registry, [
      { ...update, lastActivityAt: NOW, observedActivityAt: OBSERVED, inferredBusyAt: NOW },
    ]);
    assert.equal(registry.get(update.sessionId).lastActivityAt, OBSERVED);
  });
});

describe("mergeObservedActivityAt (#113 review F1)", () => {
  it("takes the newest candidate and ignores gaps", () => {
    assert.equal(mergeObservedActivityAt(OBSERVED, undefined, OBSERVED + 5), OBSERVED + 5);
    assert.equal(mergeObservedActivityAt(undefined, OBSERVED), OBSERVED);
  });

  it("is undefined when nothing was observed", () => {
    assert.equal(mergeObservedActivityAt(undefined, undefined), undefined);
    assert.equal(mergeObservedActivityAt(), undefined);
  });
});

describe("enrichment cache round trip (#113 review F1)", () => {
  // The leak this pins: sessionEnrichmentCache stores the *merged*
  // lastActivityAt (tiering needs it), so a heavy scan that merged the cached
  // merged value into its observed time promoted a CPU stamp to an observation
  // one scan later, and the registry then made it permanent. This mirrors the
  // Codex path's composition; the source guard below pins that scanAgents
  // actually feeds it the observed field.
  const scan = (cache, matchedActivityAt, busy, nowSec) => {
    let lastActivityAt = mergeObservedActivityAt(cache?.observedActivityAt, matchedActivityAt);
    let inferredBusyAt = (busy ? nowSec : undefined) ?? cache?.inferredBusyAt;
    if (!isInferredBusyFresh(inferredBusyAt, nowSec)) inferredBusyAt = undefined;
    const observedActivityAt = lastActivityAt;
    lastActivityAt = resolveEffectiveActivityAt(observedActivityAt, inferredBusyAt, nowSec);
    return { lastActivityAt, observedActivityAt, inferredBusyAt };
  };

  const T0 = NOW;
  const busyScan = scan(undefined, OBSERVED, true, T0);

  it("reports the burst but records the rollout mtime as observed", () => {
    assert.equal(busyScan.lastActivityAt, T0);
    assert.equal(busyScan.observedActivityAt, OBSERVED);
  });

  it("does not promote the stamp to an observation on the next scan", () => {
    const quiet = scan(busyScan, OBSERVED, false, T0 + 30);
    assert.equal(quiet.observedActivityAt, OBSERVED, "an inference must not become an observation");
    assert.equal(quiet.lastActivityAt, T0, "the burst is still reported inside the TTL");
  });

  it("returns to the rollout mtime once the carried stamp expires", () => {
    const later = scan(busyScan, OBSERVED, false, T0 + CODEX_INFERRED_BUSY_TTL_SEC + 1);
    assert.equal(later.observedActivityAt, OBSERVED);
    assert.equal(later.lastActivityAt, OBSERVED);
  });

  it("keeps observed <= reported at every step", () => {
    for (const s of [busyScan, scan(busyScan, OBSERVED, false, T0 + 30)]) {
      assert.ok(s.observedActivityAt <= s.lastActivityAt);
    }
  });
});

describe("scanAgents reads the observed field from the cache (#113 review F1)", () => {
  // A composition test cannot see which field scanAgents passes in, and that
  // choice is exactly what broke. The merged value is legitimate for tiering
  // (a busy process should stay hot) and wrong everywhere else, so pin it to
  // that one call site.
  it("uses cachedEnrichment.lastActivityAt only for tier classification", () => {
    const src = readFileSync(new URL("../src/scanner/index.ts", import.meta.url), "utf8");
    const lines = src.split("\n");
    const hits = lines.flatMap((line, i) =>
      line.includes("cachedEnrichment.lastActivityAt") ||
      line.includes("cachedEnrichment?.lastActivityAt")
        ? [i]
        : [],
    );
    assert.equal(hits.length, 1, `expected one read, found ${hits.length}`);
    // Every other path must read observedActivityAt; an undefined value there
    // means "nothing observed", never "fall back to the merged time".
    const context = lines.slice(Math.max(0, hits[0] - 4), hits[0] + 1).join("\n");
    assert.match(context, /classifySessionTier/);
  });
});

describe("worker propagation raises both times (#113 review F3)", () => {
  const parent = {
    pid: 1,
    agentName: "Claude Code",
    status: "Idle",
    cpuPercent: 0,
    memoryMb: 100,
    lastActivityAt: OBSERVED,
    observedActivityAt: OBSERVED,
  };

  it("carries the child's observed activity onto the parent", () => {
    const merged = propagateWorkerStateToParent(parent, {
      status: "Active",
      phase: "tool",
      lastActivityAt: OBSERVED + 600,
      observedActivityAt: OBSERVED + 600,
      cpuPercent: 40,
      memoryMb: 50,
    });
    assert.equal(merged.observedActivityAt, OBSERVED + 600);
    assert.equal(merged.lastActivityAt, OBSERVED + 600);
  });

  it("does not let a child's inference reach the parent's observed time", () => {
    // The child reports a burst it has no file evidence for.
    const merged = propagateWorkerStateToParent(parent, {
      status: "Active",
      phase: "tool",
      lastActivityAt: NOW,
      observedActivityAt: OBSERVED,
      cpuPercent: 40,
      memoryMb: 50,
    });
    assert.equal(merged.observedActivityAt, OBSERVED);
    assert.equal(merged.lastActivityAt, NOW);
  });
});

describe("persisting when there is no observation at all (#113 review F2)", () => {
  const base = {
    pid: 87824,
    agentName: "Codex",
    cwd: "/Users/x/.ai/projects/tossbank",
    sessionId: "019ffff2-5589-7ad2-b294-3a2024659287",
    startedAt: OBSERVED - 12000,
  };

  it("writes nothing when the only time available is an inference", () => {
    // A matched Codex session whose rollout mtime has not been read yet:
    // observedActivityAt is reported, but undefined. `?? lastActivityAt` could
    // not tell that apart from a caller that does not track it, and wrote the
    // inference to disk — where the monotonic merge made it permanent.
    const registry = new Map();
    updateRegistry(registry, [
      { ...base, lastActivityAt: NOW, observedActivityAt: undefined, inferredBusyAt: NOW },
    ]);
    assert.equal(registry.get(base.sessionId)?.lastActivityAt, undefined);
  });

  it("does not ratchet an inference in when the record already exists", () => {
    const registry = new Map();
    updateRegistry(registry, [{ ...base, lastActivityAt: OBSERVED, observedActivityAt: OBSERVED }]);
    updateRegistry(registry, [
      { ...base, lastActivityAt: NOW, observedActivityAt: undefined, inferredBusyAt: NOW },
    ]);
    assert.equal(registry.get(base.sessionId).lastActivityAt, OBSERVED);
  });
});

describe("clampRegistryActivityToObserved tolerance (#113 review F4)", () => {
  const dir = join(tmpdir(), "marmonitor-clamp-test");
  const jsonlPath = join(dir, "rollout.jsonl");
  const mtimeMs = OBSERVED * 1000 + 466; // fractional, as real mtimes are

  const record = (lastActivityAt) => ({
    sessionId: "s",
    agent: "Codex",
    cwd: "/x",
    history: [{ pid: 1, jsonlPath, startedAt: OBSERVED }],
    totalTokens: { input: 0, output: 0, cache: 0 },
    lastActivityAt,
  });

  before(async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(jsonlPath, "{}\n");
    await utimes(jsonlPath, new Date(mtimeMs), new Date(mtimeMs));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves a fractional mtime-derived stamp alone", async () => {
    // Stored as mtimeMs / 1000. A floor comparison clamped this by <1s on every
    // single load, and inflated the repaired count with pure noise.
    const stored = mtimeMs / 1000;
    const registry = new Map([["s", record(stored)]]);
    assert.equal(await clampRegistryActivityToObserved(registry), 0);
    assert.equal(registry.get("s").lastActivityAt, stored);
  });

  it("allows a Codex time that legitimately leads the rollout file", async () => {
    // mergeCodexIndexedSessions maxes the SQLite updated_at with the rollout
    // mtime, so a small lead is observed, not inferred.
    const registry = new Map([["s", record(OBSERVED + 60)]]);
    assert.equal(await clampRegistryActivityToObserved(registry), 0);
  });

  it("still repairs the drift it exists for", async () => {
    const registry = new Map([["s", record(OBSERVED + 10 * 24 * 3600)]]);
    assert.equal(await clampRegistryActivityToObserved(registry), 1);
    assert.ok(registry.get("s").lastActivityAt <= OBSERVED + 1);
  });
});

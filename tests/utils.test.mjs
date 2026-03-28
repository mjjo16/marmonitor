import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceJsonlCursor,
  buildAttentionFocusText,
  buildAttentionItems,
  buildJumpAttentionItems,
  buildStatusPills,
  buildStatuslineSummary,
  buildTmuxAttentionPills,
  buildTmuxBadgeBar,
  buildTmuxBadgeSummary,
  compactStatuslineDirLabel,
  cwdToProjectDirName,
  detectApprovalPromptPhase,
  determineStatus,
  formatElapsed,
  formatElapsedCompact,
  formatTokens,
  resolvePhaseFromHistory,
  resolvePhaseWithDecay,
  resolveSessionRegistryPath,
  selectAttentionItem,
  selectCodexSession,
  selectJumpAttentionItem,
  selectRecentSessionFile,
  selectUnmatchedTargets,
  serializeWeztermPills,
  shortenPath,
  updatePhaseHistory,
  upsertSessionRegistryEntry,
} from "../dist/output/utils.js";

describe("shortenPath", () => {
  it("replaces home with ~", () => {
    assert.equal(shortenPath("/Users/macrent/Documents/foo", "/Users/macrent"), "~/Documents/foo");
  });

  it("returns unchanged if not under home", () => {
    assert.equal(shortenPath("/opt/homebrew/bin", "/Users/macrent"), "/opt/homebrew/bin");
  });

  it("handles home at root", () => {
    assert.equal(shortenPath("/Users/macrent", "/Users/macrent"), "~");
  });

  it("handles empty home (every path starts with empty string)", () => {
    // When home is "", all paths match — this is expected behavior
    assert.equal(shortenPath("/some/path", ""), "~/some/path");
  });
});

describe("compactStatuslineDirLabel", () => {
  it("keeps short two-segment labels unchanged", () => {
    assert.equal(compactStatuslineDirLabel("/Users/macrent/.ai/projects/mjjo"), "projects/mjjo");
  });

  it("shortens long labels for narrow statusline surfaces", () => {
    assert.equal(
      compactStatuslineDirLabel(
        "/Users/macrent/Documents/valueofspace/vos-data-aws-infrastructure",
      ),
      "v/vos-data-aws…rastructure",
    );
  });
});

describe("formatElapsed", () => {
  const now = 1700000000; // fixed reference time

  it("returns ? for undefined", () => {
    assert.equal(formatElapsed(undefined, now), "?");
  });

  it("formats seconds", () => {
    assert.equal(formatElapsed(now - 30, now), "30s ago");
  });

  it("formats minutes", () => {
    assert.equal(formatElapsed(now - 300, now), "5m ago");
  });

  it("formats hours", () => {
    assert.equal(formatElapsed(now - 7200, now), "2h ago");
  });

  it("formats days", () => {
    assert.equal(formatElapsed(now - 172800, now), "2d ago");
  });

  it("returns ? for future timestamps", () => {
    assert.equal(formatElapsed(now + 100, now), "?");
  });
});

describe("formatElapsedCompact", () => {
  const now = 1700000000;

  it("formats compact seconds/minutes/hours/days", () => {
    assert.equal(formatElapsedCompact(now - 26, now), "26s");
    assert.equal(formatElapsedCompact(now - 180, now), "3m");
    assert.equal(formatElapsedCompact(now - 7200, now), "2h");
    assert.equal(formatElapsedCompact(now - 172800, now), "2d");
  });

  it("returns undefined for missing or future timestamps", () => {
    assert.equal(formatElapsedCompact(undefined, now), undefined);
    assert.equal(formatElapsedCompact(now + 10, now), undefined);
  });
});

describe("resolvePhaseWithDecay", () => {
  const decay = {
    thinking: 20,
    tool: 30,
    permission: 0,
    done: 5,
  };

  it("returns current phase when explicitly detected", () => {
    assert.equal(resolvePhaseWithDecay("thinking", "tool", 1_000, decay, 50_000), "thinking");
  });

  it("keeps cached phase within decay window", () => {
    assert.equal(resolvePhaseWithDecay(undefined, "thinking", 10_000, decay, 25_000), "thinking");
  });

  it("expires cached phase after decay window", () => {
    assert.equal(resolvePhaseWithDecay(undefined, "thinking", 10_000, decay, 40_001), undefined);
  });

  it("keeps permission indefinitely when decay is zero", () => {
    assert.equal(
      resolvePhaseWithDecay(undefined, "permission", 10_000, decay, 999_999),
      "permission",
    );
  });
});

describe("advanceJsonlCursor", () => {
  it("accumulates complete lines and keeps trailing remainder", () => {
    const state = {
      offset: 0,
      remainder: "",
      recentLines: [],
    };
    const next = advanceJsonlCursor(state, '{"a":1}\n{"b":2}', 10);
    assert.equal(next.offset, Buffer.byteLength('{"a":1}\n{"b":2}'));
    assert.deepEqual(next.recentLines, ['{"a":1}']);
    assert.equal(next.remainder, '{"b":2}');
  });

  it("resumes from remainder and trims recent lines to max count", () => {
    const state = {
      offset: 5,
      remainder: '{"b":2}',
      recentLines: ['{"a":1}'],
    };
    const next = advanceJsonlCursor(state, '\n{"c":3}\n{"d":4}\n', 2);
    assert.deepEqual(next.recentLines, ['{"c":3}', '{"d":4}']);
    assert.equal(next.remainder, "");
  });
});

describe("detectApprovalPromptPhase", () => {
  it("detects codex-style approval prompts", () => {
    assert.equal(
      detectApprovalPromptPhase("Would you like to make the following edits?"),
      "permission",
    );
    assert.equal(detectApprovalPromptPhase("Please confirm before proceeding"), "permission");
  });

  it("ignores stale approval prompts when newer output exists", () => {
    assert.equal(
      detectApprovalPromptPhase(
        [
          "Would you like to make the following edits?",
          "Reading files...",
          "Applying patch...",
        ].join("\n"),
      ),
      undefined,
    );
  });

  it("returns undefined for normal output", () => {
    assert.equal(detectApprovalPromptPhase("streaming tokens..."), undefined);
  });

  it("supports custom approval patterns", () => {
    assert.equal(
      detectApprovalPromptPhase("Need confirmation before proceeding", ["need confirmation"]),
      "permission",
    );
  });

  it("clears permission when tool/progress output resumes after prompt", () => {
    assert.equal(
      detectApprovalPromptPhase(
        ["Would you like to make the following edits?", "Applying patch..."].join("\n"),
      ),
      undefined,
    );
  });

  it("detects Gemini-style action required prompts with choice lines", () => {
    assert.equal(
      detectApprovalPromptPhase(
        [
          "Action Required",
          "Shell mkdir -p .ai/projects/mjjo/works/work_mjjo_marmonitor/issues",
          "Allow execution of: 'mkdir'?",
          "1. Allow once",
          "2. Allow for this session",
          "3. No, suggest changes",
        ].join("\n"),
        ["action required", "allow execution of:"],
        [],
      ),
      "permission",
    );
  });
});

describe("updatePhaseHistory", () => {
  it("appends a new phase transition when phase changes", () => {
    const next = updatePhaseHistory("thinking", [], "tool", 1000);
    assert.equal(next.previousPhase, "thinking");
    assert.deepEqual(next.history, [{ phase: "tool", at: 1000 }]);
  });

  it("does not append when phase is unchanged or missing", () => {
    assert.deepEqual(updatePhaseHistory("thinking", [], "thinking", 1000), {
      previousPhase: "thinking",
      history: [],
    });
    assert.deepEqual(updatePhaseHistory("thinking", [], undefined, 1000), {
      previousPhase: "thinking",
      history: [],
    });
  });

  it("trims history to max entries", () => {
    const next = updatePhaseHistory(
      "tool",
      [
        { phase: "thinking", at: 1 },
        { phase: "tool", at: 2 },
      ],
      "done",
      3,
      2,
    );
    assert.deepEqual(next.history, [
      { phase: "tool", at: 2 },
      { phase: "done", at: 3 },
    ]);
  });
});

describe("resolvePhaseFromHistory", () => {
  it("returns current phase when explicitly detected", () => {
    assert.equal(
      resolvePhaseFromHistory("tool", [{ phase: "thinking", at: 1_000 }], 5_000),
      "tool",
    );
  });

  it("reuses recent history when current phase is missing", () => {
    assert.equal(
      resolvePhaseFromHistory(undefined, [{ phase: "thinking", at: 1_000 }], 5_000, 10_000),
      "thinking",
    );
  });

  it("ignores stale history", () => {
    assert.equal(
      resolvePhaseFromHistory(undefined, [{ phase: "tool", at: 1_000 }], 20_000, 5_000),
      undefined,
    );
  });
});

describe("session registry helpers", () => {
  it("stores and resolves session registry entries by session id", () => {
    const registry = new Map();
    upsertSessionRegistryEntry(registry, {
      filePath: "/tmp/a.jsonl",
      sessionId: "sess-1",
      cwd: "/repo/a",
      firstSeenOffset: 0,
      source: "claude",
    });
    assert.equal(resolveSessionRegistryPath(registry, "sess-1"), "/tmp/a.jsonl");
    assert.equal(resolveSessionRegistryPath(registry, "missing"), undefined);
  });
});

describe("selectRecentSessionFile", () => {
  const nowMs = 1_000_000;

  it("returns the clearly newest recent candidate", () => {
    assert.equal(
      selectRecentSessionFile(
        [
          { path: "/tmp/old.jsonl", mtimeMs: nowMs - 10 * 60 * 1000 },
          { path: "/tmp/new.jsonl", mtimeMs: nowMs - 60 * 1000 },
        ],
        nowMs,
      ),
      "/tmp/new.jsonl",
    );
  });

  it("returns undefined when the newest candidate is too old", () => {
    assert.equal(
      selectRecentSessionFile(
        [{ path: "/tmp/old.jsonl", mtimeMs: nowMs - 5 * 24 * 60 * 60 * 1000 }],
        nowMs,
      ),
      undefined,
    );
  });

  it("returns undefined when the newest candidate is not clearly ahead", () => {
    assert.equal(
      selectRecentSessionFile(
        [
          { path: "/tmp/a.jsonl", mtimeMs: nowMs - 60 * 1000 },
          { path: "/tmp/b.jsonl", mtimeMs: nowMs - 2 * 60 * 1000 },
        ],
        nowMs,
        72 * 60 * 60 * 1000,
        3 * 60 * 1000,
      ),
      undefined,
    );
  });
});

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    assert.equal(formatTokens(42), "42");
    assert.equal(formatTokens(999), "999");
  });

  it("formats thousands as K", () => {
    assert.equal(formatTokens(1000), "1.0K");
    assert.equal(formatTokens(1234), "1.2K");
    assert.equal(formatTokens(15668), "15.7K");
  });

  it("formats millions as M", () => {
    assert.equal(formatTokens(1000000), "1.0M");
    assert.equal(formatTokens(2500000), "2.5M");
    assert.equal(formatTokens(43600000), "43.6M");
  });

  it("handles zero", () => {
    assert.equal(formatTokens(0), "0");
  });
});

describe("cwdToProjectDirName", () => {
  it("replaces slashes with hyphens", () => {
    assert.equal(cwdToProjectDirName("/Users/macrent/Documents"), "-Users-macrent-Documents");
  });

  it("replaces dots with hyphens (matching Claude Code behavior)", () => {
    assert.equal(cwdToProjectDirName("/Users/macrent/.ai/projects"), "-Users-macrent--ai-projects");
  });

  it("handles double dots in path", () => {
    assert.equal(
      cwdToProjectDirName("/Users/macrent/.ai/projects/.vos"),
      "-Users-macrent--ai-projects--vos",
    );
  });

  it("handles root path", () => {
    assert.equal(cwdToProjectDirName("/"), "-");
  });
});

describe("determineStatus", () => {
  it("returns Unmatched when session not matched", () => {
    assert.equal(determineStatus(5.0, 100, false, 0.5, 30), "Unmatched");
  });

  it("returns Active when CPU above threshold", () => {
    assert.equal(determineStatus(2.0, 100, true, 0.5, 30), "Active");
  });

  it("returns Idle when CPU low and within stalled threshold", () => {
    assert.equal(determineStatus(0.1, 600, true, 0.5, 30), "Idle");
  });

  it("returns Stalled when idle too long", () => {
    // 30 min = 1800 sec, CPU near 0
    assert.equal(determineStatus(0.05, 2000, true, 0.5, 30), "Stalled");
  });

  it("returns Idle when elapsed is undefined", () => {
    assert.equal(determineStatus(0.1, undefined, true, 0.5, 30), "Idle");
  });

  it("returns Active for recent active phases even when CPU is low", () => {
    assert.equal(determineStatus(0.05, 45, true, 0.5, 30, "tool"), "Active");
    assert.equal(determineStatus(0.05, 45, true, 0.5, 30, "thinking"), "Active");
    assert.equal(determineStatus(0.05, 45, true, 0.5, 30, "permission"), "Active");
  });

  it("does not keep old active phases alive forever", () => {
    assert.equal(determineStatus(0.05, 400, true, 0.5, 30, "tool"), "Idle");
  });

  it("respects custom thresholds", () => {
    // CPU 1.0 with threshold 2.0 = not active
    assert.equal(determineStatus(1.0, 100, true, 2.0, 30), "Idle");
    // CPU 1.0 with threshold 0.5 = active
    assert.equal(determineStatus(1.0, 100, true, 0.5, 30), "Active");
  });

  it("respects custom stalled time", () => {
    // 10 min stalled threshold, 15 min elapsed
    assert.equal(determineStatus(0.05, 900, true, 0.5, 10), "Stalled");
    // 60 min stalled threshold, 15 min elapsed = still Idle
    assert.equal(determineStatus(0.05, 900, true, 0.5, 60), "Idle");
  });
});

describe("selectCodexSession", () => {
  const sameCwdSessions = [
    { cwd: "/repo", timestamp: 1000, id: "older" },
    { cwd: "/repo", timestamp: 1500, id: "middle" },
    { cwd: "/repo", timestamp: 2200, id: "newer" },
  ];

  it("returns undefined when no cwd matches", () => {
    assert.equal(selectCodexSession("/other", 1500, sameCwdSessions), undefined);
  });

  it("returns the only cwd match", () => {
    const sessions = [
      { cwd: "/repo-a", timestamp: 1000, id: "a" },
      { cwd: "/repo-b", timestamp: 1100, id: "b" },
    ];
    assert.deepEqual(selectCodexSession("/repo-b", 1200, sessions), sessions[1]);
  });

  it("picks the closest timestamp when same cwd has multiple sessions", () => {
    assert.deepEqual(selectCodexSession("/repo", 1600, sameCwdSessions), sameCwdSessions[1]);
    assert.deepEqual(selectCodexSession("/repo", 2150, sameCwdSessions), sameCwdSessions[2]);
  });

  it("falls back to the most recent session when process start time is missing", () => {
    assert.deepEqual(selectCodexSession("/repo", undefined, sameCwdSessions), sameCwdSessions[2]);
  });
});

describe("selectUnmatchedTargets", () => {
  const agents = [
    { pid: 300, status: "Idle", agentName: "Claude Code", cwd: "/a" },
    { pid: 200, status: "Unmatched", agentName: "Codex", cwd: "/b" },
    { pid: 100, status: "Unmatched", agentName: "Codex", cwd: "/c" },
  ];

  it("returns all unmatched processes sorted by pid", () => {
    assert.deepEqual(
      selectUnmatchedTargets(agents).map((agent) => agent.pid),
      [100, 200],
    );
  });

  it("filters unmatched processes by selected pid", () => {
    assert.deepEqual(
      selectUnmatchedTargets(agents, [200, 999]).map((agent) => agent.pid),
      [200],
    );
  });
});

describe("buildStatuslineSummary", () => {
  it("builds compact summary with alert counts and metrics", () => {
    assert.equal(
      buildStatuslineSummary(
        {
          aliveCount: 17,
          waitingCount: 1,
          riskCount: 0,
          stalledCount: 4,
          unmatchedCount: 2,
          activeCount: 6,
          highCpuCount: 1,
          cpuPercent: 8,
          memoryUsedGb: 36,
        },
        "compact",
      ),
      "AI17 !1 S4 O2 | 8% 36G",
    );
  });

  it("builds compact summary with ok when there are no alerts", () => {
    assert.equal(
      buildStatuslineSummary(
        {
          aliveCount: 3,
          waitingCount: 0,
          riskCount: 0,
          stalledCount: 0,
          unmatchedCount: 0,
          activeCount: 1,
          highCpuCount: 0,
        },
        "compact",
      ),
      "AI3 ok",
    );
  });

  it("builds standard summary", () => {
    assert.equal(
      buildStatuslineSummary(
        {
          aliveCount: 17,
          waitingCount: 1,
          riskCount: 0,
          stalledCount: 4,
          unmatchedCount: 2,
          activeCount: 6,
          highCpuCount: 1,
          cpuPercent: 8,
          memoryUsedGb: 36,
        },
        "standard",
      ),
      "AI 17 | wait 1 | stalled 4 | orphan 2 | CPU 8%",
    );
  });

  it("builds extended summary with active/hot/memory", () => {
    assert.equal(
      buildStatuslineSummary(
        {
          aliveCount: 17,
          waitingCount: 1,
          riskCount: 2,
          stalledCount: 4,
          unmatchedCount: 2,
          activeCount: 6,
          highCpuCount: 1,
          cpuPercent: 8,
          memoryUsedGb: 36,
        },
        "extended",
      ),
      "AI 17 | wait 1 | risk 2 | stalled 4 | orphan 2 | active 6 | hot 1 | CPU 8% | MEM 36G",
    );
  });

  it("builds tmux badge summary", () => {
    const snapshot = {
      aliveCount: 19,
      waitingCount: 2,
      riskCount: 0,
      stalledCount: 1,
      unmatchedCount: 1,
      activeCount: 8,
      highCpuCount: 1,
      thinkingCount: 3,
      toolCount: 1,
      claudeCount: 14,
      codexCount: 2,
      geminiCount: 3,
    };
    assert.equal(buildTmuxBadgeSummary(snapshot), "Cl 14  Cx 2  Gm 3   ⏳ 2  ⚠ 2  🤔 3  🔧 1");
    assert.equal(buildStatuslineSummary(snapshot, "tmux-badges"), buildTmuxBadgeSummary(snapshot));
    assert.equal(
      buildStatuslineSummary(snapshot, "wezterm-pills"),
      buildTmuxBadgeSummary(snapshot),
    );
  });

  it("builds tmux styled badge bar", () => {
    const text = buildTmuxBadgeBar(
      {
        aliveCount: 19,
        waitingCount: 2,
        riskCount: 0,
        stalledCount: 1,
        unmatchedCount: 1,
        activeCount: 8,
        highCpuCount: 1,
        thinkingCount: 3,
        toolCount: 1,
        claudeCount: 14,
        codexCount: 2,
        geminiCount: 3,
      },
      "⏳ Claude mjjo allow",
    );
    assert.match(text, /Cl 14/);
    assert.match(text, /Cx 2/);
    assert.match(text, /Gm 3/);
    assert.match(text, /⏳ 2/);
    assert.match(text, /⚠ 2/);
    assert.match(text, /🤔 3/);
    assert.match(text, /🔧 1/);
    assert.match(text, /Claude mjjo allow/);
    assert.match(text, /#\[fg=/);
  });

  it("builds shared status pills for terminal adapters", () => {
    const { agents, alerts } = buildStatusPills({
      aliveCount: 16,
      waitingCount: 1,
      riskCount: 0,
      stalledCount: 2,
      unmatchedCount: 1,
      activeCount: 7,
      highCpuCount: 0,
      thinkingCount: 2,
      toolCount: 1,
      claudeCount: 14,
      codexCount: 2,
      geminiCount: 0,
    });

    assert.deepEqual(
      agents.map((pill) => pill.label),
      ["Cl 14", "Cx 2"],
    );
    assert.deepEqual(
      alerts.map((pill) => pill.label),
      ["⏳ 1", "⚠ 3", "🤔 2", "🔧 1"],
    );
  });

  it("serializes wezterm pills as parseable lines", () => {
    const text = serializeWeztermPills(
      {
        aliveCount: 16,
        waitingCount: 1,
        riskCount: 0,
        stalledCount: 2,
        unmatchedCount: 1,
        activeCount: 7,
        highCpuCount: 0,
        thinkingCount: 2,
        toolCount: 1,
        claudeCount: 14,
        codexCount: 2,
        geminiCount: 0,
      },
      "🤔Cl projects/kbank 1d │ ⚠Cx valueofspace/vos-fe-data-eng 1d",
    );

    assert.match(text, /^agent\tCl 14\t#1e1e2e\t#fab387/m);
    assert.match(text, /^agent\tCx 2\t#1e1e2e\t#94e2d5/m);
    assert.match(text, /^alert\t⏳ 1\t#11111b\t#f38ba8/m);
    assert.match(text, /^focus\t🤔Cl projects\/kbank 1d\t#bac2de\t#181825/m);
    assert.match(text, /^focus\t⚠Cx valueofspace\/vos-fe-data-eng 1d\t#bac2de\t#181825/m);
  });
});

describe("buildAttentionItems", () => {
  it("selects only attention-worthy agents in priority order", () => {
    const agents = [
      { pid: 10, agentName: "Claude Code", cwd: "/repo/a", status: "Idle", lastActivityAt: 3000 },
      { pid: 20, agentName: "Codex", cwd: "/repo/b", status: "Unmatched", runtimeSource: "vscode" },
      { pid: 30, agentName: "Claude Code", cwd: "/repo/c", status: "Active", phase: "permission" },
      { pid: 40, agentName: "Claude Code", cwd: "/repo/d", status: "Stalled" },
      {
        pid: 50,
        agentName: "Codex",
        cwd: "/repo/e",
        status: "Active",
        phase: "thinking",
        lastActivityAt: 2000,
      },
      {
        pid: 60,
        agentName: "Codex",
        cwd: "/repo/f",
        status: "Active",
        phase: "tool",
        lastActivityAt: 1000,
      },
    ];

    assert.deepEqual(
      buildAttentionItems(agents).map((item) => [item.kind, item.pid]),
      [
        ["permission", 30],
        ["thinking", 50],
        ["active", 10],
        ["tool", 60],
      ],
    );
  });

  it("sorts same-priority items by newest activity first", () => {
    const agents = [
      {
        pid: 100,
        agentName: "Claude Code",
        cwd: "/repo/a",
        status: "Active",
        phase: "thinking",
        lastActivityAt: 1000,
      },
      {
        pid: 200,
        agentName: "Claude Code",
        cwd: "/repo/b",
        status: "Active",
        phase: "thinking",
        lastActivityAt: 2000,
      },
    ];

    assert.deepEqual(
      buildAttentionItems(agents).map((item) => item.pid),
      [200, 100],
    );
  });

  it("selects an attention item by 1-based index", () => {
    const agents = [
      { pid: 20, agentName: "Codex", cwd: "/repo/b", status: "Unmatched" },
      { pid: 30, agentName: "Claude Code", cwd: "/repo/c", status: "Active", phase: "permission" },
      { pid: 40, agentName: "Codex", cwd: "/repo/d", status: "Idle", lastActivityAt: 1000 },
    ];

    assert.equal(selectAttentionItem(agents, 1)?.pid, 30);
    assert.equal(selectAttentionItem(agents, 2)?.pid, 40);
    assert.equal(selectAttentionItem(agents, 3), undefined);
  });

  it("builds jump attention items with permission/thinking first, then recent alive sessions", () => {
    const agents = [
      { pid: 20, agentName: "Codex", cwd: "/repo/b", status: "Unmatched" },
      {
        pid: 30,
        agentName: "Claude Code",
        cwd: "/repo/c",
        status: "Active",
        phase: "permission",
        lastActivityAt: 3000,
      },
      {
        pid: 35,
        agentName: "Claude Code",
        cwd: "/repo/t",
        status: "Active",
        phase: "thinking",
        lastActivityAt: 2000,
      },
      { pid: 40, agentName: "Codex", cwd: "/repo/d", status: "Stalled" },
      {
        pid: 50,
        agentName: "Codex",
        cwd: "/repo/e",
        status: "Active",
        phase: "tool",
        lastActivityAt: 1500,
      },
      { pid: 60, agentName: "Claude Code", cwd: "/repo/f", status: "Idle", lastActivityAt: 2500 },
    ];

    assert.deepEqual(
      buildJumpAttentionItems(agents).map((item) => [item.kind, item.pid]),
      [
        ["permission", 30],
        ["thinking", 35],
        ["active", 60],
        ["tool", 50],
      ],
    );
  });

  it("selects a jump attention item by 1-based index", () => {
    const agents = [
      { pid: 20, agentName: "Codex", cwd: "/repo/b", status: "Unmatched" },
      { pid: 30, agentName: "Claude Code", cwd: "/repo/c", status: "Active", phase: "permission" },
      { pid: 40, agentName: "Codex", cwd: "/repo/d", status: "Idle", lastActivityAt: 1000 },
    ];

    assert.equal(selectJumpAttentionItem(agents, 1)?.pid, 30);
    assert.equal(selectJumpAttentionItem(agents, 2)?.pid, 40);
    assert.equal(selectJumpAttentionItem(agents, 3), undefined);
  });

  it("keeps thinking first, then recent alive sessions in condensed focus text", () => {
    const now = Math.floor(Date.now() / 1000);
    const text = buildAttentionFocusText([
      {
        kind: "tool",
        priority: 2,
        pid: 50,
        agentName: "Codex",
        cwd: "/repo/tool",
        status: "Active",
        phase: "tool",
        lastActivityAt: now - 5,
      },
      {
        kind: "active",
        priority: 2,
        pid: 55,
        agentName: "Claude Code",
        cwd: "/repo/active",
        status: "Idle",
        lastActivityAt: now - 8,
      },
      {
        kind: "thinking",
        priority: 1,
        pid: 60,
        agentName: "Claude Code",
        cwd: "/repo/thinking",
        status: "Active",
        phase: "thinking",
        lastActivityAt: now - 10,
      },
    ]);

    assert.equal(text, "🤔Cl repo/thinking 10s │ 🔧Cx repo/tool 5s │ •Cl repo/active 8s");
  });

  it("builds condensed focus text from top attention items", () => {
    const now = Math.floor(Date.now() / 1000);
    const text = buildAttentionFocusText([
      {
        kind: "unmatched",
        priority: 0,
        pid: 20,
        agentName: "Codex",
        cwd: "/repo/b",
        status: "Unmatched",
      },
      {
        kind: "permission",
        priority: 1,
        pid: 30,
        agentName: "Claude Code",
        cwd: "/Users/macrent/.ai/projects/mjjo",
        status: "Active",
        phase: "permission",
      },
      {
        kind: "thinking",
        priority: 3,
        pid: 50,
        agentName: "Codex",
        cwd: "/Users/macrent/Documents/valueofspace/vos-data-service",
        status: "Active",
        phase: "thinking",
        lastActivityAt: now - 26,
      },
    ]);

    assert.equal(text, "⏳Cl projects/mjjo allow │ 🤔Cx v/vos-data-service 26s");
  });

  it("reduces focus item count on narrow widths before truncating everything", () => {
    const now = Math.floor(Date.now() / 1000);
    const text = buildAttentionFocusText(
      [
        {
          kind: "permission",
          priority: 1,
          pid: 30,
          agentName: "Claude Code",
          cwd: "/Users/macrent/.ai/projects/mjjo",
          status: "Active",
          phase: "permission",
        },
        {
          kind: "thinking",
          priority: 3,
          pid: 50,
          agentName: "Codex",
          cwd: "/Users/macrent/Documents/valueofspace/vos-data-service",
          status: "Active",
          phase: "thinking",
          lastActivityAt: now - 26,
        },
        {
          kind: "active",
          priority: 4,
          pid: 60,
          agentName: "Claude Code",
          cwd: "/Users/macrent/Documents/valueofspace/vos-data-utils",
          status: "Idle",
          lastActivityAt: now - 45,
        },
      ],
      5,
      60,
    );

    assert.equal(text, "⏳Cl p/mjjo allow");
  });

  it("returns undefined when only unmatched items exist", () => {
    const text = buildAttentionFocusText([
      {
        kind: "unmatched",
        priority: 0,
        pid: 20,
        agentName: "Codex",
        cwd: "/repo/b",
        status: "Unmatched",
      },
    ]);

    assert.equal(text, undefined);
  });

  it("returns undefined when only stalled items exist", () => {
    const text = buildAttentionFocusText([
      {
        kind: "stalled",
        priority: 2,
        pid: 20,
        agentName: "Codex",
        cwd: "/repo/b",
        status: "Stalled",
      },
    ]);

    assert.equal(text, undefined);
  });

  it("builds numbered tmux attention pills for direct jump", () => {
    const now = Math.floor(Date.now() / 1000);
    const text = buildTmuxAttentionPills(
      [
        {
          kind: "permission",
          priority: 1,
          pid: 30,
          agentName: "Claude Code",
          cwd: "/Users/macrent/.ai/projects/mjjo",
          status: "Active",
          phase: "permission",
        },
        {
          kind: "thinking",
          priority: 1,
          pid: 50,
          agentName: "Claude Code",
          cwd: "/Users/macrent/.ai/projects/kbank",
          status: "Active",
          phase: "thinking",
          lastActivityAt: now - 26,
        },
        {
          kind: "active",
          priority: 2,
          pid: 60,
          agentName: "Codex",
          cwd: "/Users/macrent/Documents/valueofspace/vos-data-service",
          status: "Idle",
          lastActivityAt: now - 10,
        },
      ],
      5,
    );

    assert.match(text, / 1 /);
    assert.match(text, /⏳Cl projects\/mjjo allow/);
    assert.match(text, / 2 /);
    assert.match(text, /🤔Cl projects\/kbank 26s/);
    assert.match(text, / 3 /);
    assert.match(text, /•Cx v\/vos-data-service 10s/);
    assert.match(text, /#\[bold,fg=/);
  });

  it("reduces tmux attention pills on narrow widths", () => {
    const now = Math.floor(Date.now() / 1000);
    const text = buildTmuxAttentionPills(
      [
        {
          kind: "permission",
          priority: 1,
          pid: 30,
          agentName: "Claude Code",
          cwd: "/Users/macrent/.ai/projects/mjjo",
          status: "Active",
          phase: "permission",
        },
        {
          kind: "thinking",
          priority: 1,
          pid: 50,
          agentName: "Claude Code",
          cwd: "/Users/macrent/.ai/projects/kbank",
          status: "Active",
          phase: "thinking",
          lastActivityAt: now - 26,
        },
        {
          kind: "active",
          priority: 2,
          pid: 60,
          agentName: "Codex",
          cwd: "/Users/macrent/Documents/valueofspace/vos-data-service",
          status: "Idle",
          lastActivityAt: now - 10,
        },
      ],
      5,
      60,
    );

    assert.match(text, /⏳Cl p\/mjjo allow/);
    assert.doesNotMatch(text, /🤔Cl/);
    assert.doesNotMatch(text, /•Cx/);
  });
});

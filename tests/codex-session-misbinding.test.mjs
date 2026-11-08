/**
 * Regression tests for local issue #114 — two Codex processes on one session.
 *
 * Measured on the live machine before the fix: the tmux statusline showed
 * `vos-aws-infrastructure` twice and both pills jumped to the same session.
 * Three distinct things were involved, and marmonitor picked none of them:
 *
 *   PID 72208  ChatGPT.app codex sandbox, --session-id 77be15a2…
 *   PID 94171  codex resume 019fee78-4612-77f2-b745-f71f87c5f49d
 *   bound to   019ffff3-bd10-…  (a stale 08-14 rollout, neither process's)
 *
 * 94171's real session was not merely different, it was active that day. The
 * proximity sort lost because a resumed thread's file is dated when the thread
 * began (08-11) while the process started when it was resumed (08-20), so an
 * unrelated newer session in the same cwd won.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { parseCodexSessionIdFromCmd, selectCodexSessionForProcess } from "../dist/scanner/codex.js";
import { detectAgentFromProcessSignature } from "../dist/scanner/process.js";

const RESUMED = "019fee78-4612-77f2-b745-f71f87c5f49d";
const STALE = "019ffff3-bd10-7873-bb6e-4f1886292434";
const CWD = "/Users/macrent/Documents/valueofspace/vos-aws-infrastructure";
const RESUME_CMD = `node /opt/homebrew/bin/codex resume ${RESUMED}`;
const SANDBOX_CMD =
  '/Applications/ChatGPT.app/Contents/Resources/codex sandbox -c shell_environment_policy.inherit="all" -- /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --session-id 77be15a298294e26b50673b51ad85286';

const session = (id, timestamp) => ({ id, cwd: CWD, timestamp, filePath: `/r/${id}.jsonl` });
const RESUMED_SESSION = session(RESUMED, 1786000000); // 08-11, when the thread began
const STALE_SESSION = session(STALE, 1786700000); // 08-14, nearer the process start

const pick = (overrides) =>
  selectCodexSessionForProcess({
    declaredSessionId: undefined,
    sessions: [RESUMED_SESSION, STALE_SESSION],
    claimedSessionIds: new Set(),
    argvReservedSessionIds: new Set(),
    cwd: CWD,
    processStartedAt: 1787200000, // 08-20, the resume
    ...overrides,
  });

describe("parseCodexSessionIdFromCmd (#114)", () => {
  it("reads the thread a process resumed", () => {
    assert.equal(parseCodexSessionIdFromCmd(RESUME_CMD), RESUMED);
  });

  it("reads a --session-id flag", () => {
    assert.equal(parseCodexSessionIdFromCmd(SANDBOX_CMD), "77be15a298294e26b50673b51ad85286");
  });

  it("normalises case", () => {
    assert.equal(parseCodexSessionIdFromCmd(RESUME_CMD.toUpperCase()), RESUMED);
  });

  it("finds nothing in a plain invocation", () => {
    assert.equal(parseCodexSessionIdFromCmd("node /opt/homebrew/bin/codex"), undefined);
    assert.equal(parseCodexSessionIdFromCmd(undefined), undefined);
  });

  it("does not mistake a bare word for an id", () => {
    assert.equal(parseCodexSessionIdFromCmd("codex resume latest"), undefined);
  });
});

describe("selectCodexSessionForProcess (#114)", () => {
  it("reproduces the misbinding when nothing is declared", () => {
    // The pre-fix behaviour, kept explicit: proximity picks the stale session.
    assert.equal(pick({}).id, STALE);
  });

  it("prefers the declared thread over the nearer one", () => {
    assert.equal(pick({ declaredSessionId: RESUMED }).id, RESUMED);
  });

  it("refuses when the declared thread is already taken", () => {
    // A second process resuming the same thread must not get a consolation
    // guess — that is precisely how two pills ended up on one session.
    assert.equal(
      pick({ declaredSessionId: RESUMED, claimedSessionIds: new Set([RESUMED]) }),
      undefined,
    );
  });

  it("refuses when the declared thread is not indexed", () => {
    assert.equal(pick({ declaredSessionId: "019fffff-0000-7000-8000-000000000000" }), undefined);
  });

  it("does not hand a guesser a session another process declared", () => {
    assert.equal(pick({ argvReservedSessionIds: new Set([STALE]) }).id, RESUMED);
    assert.equal(
      pick({ argvReservedSessionIds: new Set([STALE, RESUMED]) }),
      undefined,
      "with every session spoken for, refuse rather than misbind",
    );
  });

  it("skips a session already claimed this cycle", () => {
    assert.equal(pick({ claimedSessionIds: new Set([STALE]) }).id, RESUMED);
  });

  it("lets the persisted binding win over proximity", () => {
    assert.equal(pick({ resolveBinding: () => RESUMED_SESSION }).id, RESUMED);
  });

  it("only offers the binding sessions that are still free", () => {
    const offered = [];
    pick({
      claimedSessionIds: new Set([STALE]),
      resolveBinding: (available) => {
        offered.push(...available.map((s) => s.id));
        return undefined;
      },
    });
    assert.deepEqual(offered, [RESUMED]);
  });
});

describe("stale persisted Codex bindings", () => {
  // Observed on 2026-11-08: PID 58195 started 11-07 16:38:09 and created its
  // rollout six seconds later, but the registry still held a heuristic guess
  // whose file was last written on 11-02, before the process existed.
  const START = Date.parse("2026-11-07T07:38:09Z") / 1000;
  const old = {
    ...session("01a16303-a223-7a21-b6f5-441aef0ca267", Date.parse("2026-10-22T09:49:04Z") / 1000),
    lastActivityAt: Date.parse("2026-11-02T13:42:29Z") / 1000,
  };
  const born = {
    ...session("01a1b4f1-90e0-7491-8b4a-c9c4225d2699", START + 6),
    lastActivityAt: Date.now() / 1000,
  };
  const pickWith = (sessions, bound, overrides = {}) =>
    pick({ sessions, processStartedAt: START, resolveBinding: () => bound, ...overrides });

  it("replaces a binding the process never wrote with the rollout it created", () => {
    assert.equal(pickWith([old, born], old)?.id, born.id);
  });

  it("keeps a binding the process has written since it started", () => {
    // PID 17851 resumed an older thread inside the TUI and kept writing it,
    // abandoning the rollout it created at startup.
    const resumed = { ...old, lastActivityAt: START + 86400 };
    assert.equal(pickWith([resumed, born], resumed)?.id, old.id);
  });

  it("keeps an untouched binding when no rollout was born with the process", () => {
    assert.equal(pickWith([old], old)?.id, old.id);
  });

  it("keeps the binding when two rollouts were born together", () => {
    const twin = { ...session("01a1b4f2-0000-7000-8000-000000000000", START + 9) };
    assert.equal(pickWith([old, born, twin], old)?.id, old.id);
  });

  it("ignores a rollout born in another cwd", () => {
    const elsewhere = { ...born, cwd: "/elsewhere" };
    assert.equal(pickWith([old, elsewhere], old)?.id, old.id);
  });
});

describe("ChatGPT app sandbox helpers are not sessions (#114)", () => {
  const config = getDefaults();

  it("excludes codex sandbox", () => {
    assert.equal(
      detectAgentFromProcessSignature({ name: "codex", cmd: SANDBOX_CMD }, config),
      null,
    );
  });

  it("still detects a real codex CLI", () => {
    assert.equal(
      detectAgentFromProcessSignature({ name: "node", cmd: RESUME_CMD }, config),
      "Codex",
    );
  });

  it("does not exclude a process merely mentioning sandbox settings", () => {
    assert.equal(
      detectAgentFromProcessSignature(
        { name: "node", cmd: "node /opt/homebrew/bin/codex -c sandbox_mode=danger-full-access" },
        config,
      ),
      "Codex",
    );
  });
});

// Read-only regression checks for session tracking, run against the installed
// daemon. Every check compares the daemon snapshot with an independent source
// (ps, tty, tmux panes, session file mtimes, Claude pid.json) instead of
// trusting marmonitor's own reasoning. Nothing here signals or edits anything.
//
//   node scripts/soak-check.mjs [--out <dir>]   run once, append to <dir>/soak.jsonl
//   node scripts/soak-check.mjs --summary [--out <dir>]   aggregate a soak period
import { execFile, execFileSync } from "node:child_process";
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// launchd does not set TMPDIR, so os.tmpdir() falls back to /tmp while the
// daemon writes under the per-user Darwin temp dir. Resolve it once so this
// script and the marmonitor CLI it spawns read the daemon's runtime files.
if (!process.env.TMPDIR && process.platform === "darwin") {
  try {
    const dir = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
    if (dir) process.env.TMPDIR = dir;
  } catch {
    // keep the os.tmpdir() fallback
  }
}
const args = process.argv.slice(2);
const outDir = args.includes("--out")
  ? args[args.indexOf("--out") + 1]
  : join(homedir(), ".local", "state", "marmonitor-soak");
const runtimeDir = join(tmpdir(), "marmonitor");
const claudeHome = process.env.MARMONITOR_CLAUDE_HOME ?? join(homedir(), ".claude");
const codexHome = process.env.MARMONITOR_CODEX_HOME ?? join(homedir(), ".codex");
const nowSec = Date.now() / 1000;
const START_SLACK_SEC = 5;
const INFERRED_TTL_SEC = 180;

// Issue references are local issue numbers unless prefixed with GH.
const CHECKS = {
  daemon: "#093 #116 single live daemon, fresh snapshot",
  helperCounted: "GH#74 #100 #114 only terminal CLIs are counted",
  cliMissing: "GH#74 every terminal CLI is counted",
  sharedSession: "#108 #114 GH#68 no two live PIDs share a session",
  staleBinding: "#096 #107 #114 bound file was written by this process",
  pidJson: "#107 owned Claude pid.json wins",
  inferredActivity: "#113 inferred activity never outlives its TTL",
  unmatchedStuck: "#111 unmatched CLIs resolve within 10 minutes",
  duplicateLabel: "GH#75 statusline labels are unique",
  badgeCount: "GH#74 statusline counts equal terminal CLIs",
  paneMapping: "#108 GH#75 each tmux CLI maps to exactly one pane",
  registryGrowth: "#115 session registry history stays bounded",
};

async function run(cmd, cmdArgs) {
  try {
    const { stdout } = await exec(cmd, cmdArgs, {
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return "";
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function mtimeSec(path) {
  try {
    return (await stat(path)).mtimeMs / 1000;
  } catch {
    return undefined;
  }
}

async function head(path, bytes = 4096) {
  try {
    const fh = await open(path, "r");
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(bytes), 0, bytes, 0);
    await fh.close();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  }
}

async function listProcesses() {
  const rows = new Map();
  // lstart is a fixed five-token date under LC_ALL=C.
  for (const line of (await run("ps", ["-axo", "pid=,ppid=,tty=,lstart=,args="])).split("\n")) {
    const m = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
    if (!m) continue;
    rows.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      tty: m[3],
      startedAt: Date.parse(m[4]) / 1000,
      args: m[5],
      comm: "",
    });
  }
  for (const line of (await run("ps", ["-axo", "pid=,comm="])).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    const row = m && rows.get(Number(m[1]));
    if (row) row.comm = m[2];
  }
  return rows;
}

const NODE_ENTRIES = {
  "Claude Code": /@anthropic-ai[/\\]claude-code[/\\]cli\.js/,
  Codex: /@openai[/\\]codex[/\\]bin[/\\]codex\.js|[/\\]bin[/\\]codex(\s|$)/,
  Gemini: /@google[/\\]gemini-cli[/\\]|[/\\]bin[/\\]gemini(\s|$)/,
};
const NATIVE = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
const CODEX_NON_SESSION =
  /^(app-server|exec-server|mcp-server|sandbox|login|logout|mcp|plugin|completion|update|doctor|debug|apply|cloud|features|help|archive|delete|unarchive|queue|migrate-\S+)$/;

/** Terminal-attached agent CLIs, derived from ps alone. */
function groundTruthClis(procs) {
  const clis = new Map();
  for (const p of procs.values()) {
    if (p.tty === "??" || p.tty === "-") continue;
    const name = basename(p.comm).toLowerCase();
    let agent = NATIVE[name];
    if (!agent && (name === "node" || name === "nodejs")) {
      agent = Object.keys(NODE_ENTRIES).find((a) => NODE_ENTRIES[a].test(p.args));
    }
    if (!agent) continue;
    if (agent === "Codex") {
      const sub = p.args
        .split(/\s+/)
        .slice(1)
        .find((w) => !w.startsWith("-"));
      if (sub && CODEX_NON_SESSION.test(sub)) continue;
    }
    clis.set(p.pid, { ...p, agent });
  }
  // A wrapper and its native child are one CLI; keep the outermost.
  for (const cli of [...clis.values()]) {
    const parent = clis.get(cli.ppid);
    if (parent && parent.agent === cli.agent) cli.childOf = parent.pid;
  }
  return clis;
}

function family(pid, clis) {
  const ids = new Set([pid]);
  for (const cli of clis.values()) if (cli.childOf === pid) ids.add(cli.pid);
  return ids;
}

async function indexCodexRollouts() {
  const byId = new Map();
  async function walk(dir, depth) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(path, depth + 1);
      const m = e.isFile() && e.name.match(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/);
      if (m) byId.set(m[1], path);
    }
  }
  await walk(join(codexHome, "sessions"), 0);
  return byId;
}

function claudeProjectDir(cwd) {
  return join(claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

async function sessionFiles(agent, cwd, rollouts) {
  if (agent === "Claude Code") {
    const dir = claudeProjectDir(cwd);
    try {
      return (await readdir(dir))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ id: f.slice(0, -6), path: join(dir, f) }));
    } catch {
      return [];
    }
  }
  if (agent === "Codex") {
    return [...rollouts].map(([id, path]) => ({ id, path }));
  }
  return [];
}

async function fileCwd(agent, path) {
  if (agent !== "Codex") return undefined;
  return (await head(path)).match(/"cwd":"([^"]+)"/)?.[1];
}

async function tmuxPanes() {
  const raw = await run("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_tty}",
  ]);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, pid, target, tty] = l.split("\t");
      return { id, pid: Number(pid), target, tty };
    });
}

function parseBadges(text) {
  // Drop tmux styles and Powerline separators (private-use glyphs).
  const plain = text
    .replace(/#\[[^\]]*\]/g, "")
    .replace(/[-]/g, " ")
    .replace(/\s+/g, " ");
  const counts = {};
  for (const m of plain.matchAll(/\b(Cl|Cx|Gm)\s+(\d+)\b/g)) counts[m[1]] ??= Number(m[2]);
  const pills = [];
  for (const m of plain.matchAll(
    /(?:^|\s)(\d)\s+[^\s\w]+(Cl|Cx|Gm)\s+(.+?)\s+(\d+[smhd]|now)(?=\s|$)/g,
  )) {
    pills.push({ index: Number(m[1]), agent: m[2], label: m[3] });
  }
  return { counts, pills };
}

async function check() {
  const violations = [];
  const warnings = [];
  const flag = (list, checkId, detail) => list.push({ check: checkId, ...detail });

  const snapshotPath = join(runtimeDir, "daemon-snapshot.json");
  const [snapshot, snapshotMtime, pidText, procs, rollouts, panes, registry, state] =
    await Promise.all([
      readJson(snapshotPath),
      mtimeSec(snapshotPath),
      readFile(join(runtimeDir, "daemon.pid"), "utf8").catch(() => ""),
      listProcesses(),
      indexCodexRollouts(),
      tmuxPanes(),
      readJson(join(homedir(), ".config", "marmonitor", "session-registry.json")),
      readJson(join(outDir, "state.json")).then((s) => s ?? { unmatchedSince: {} }),
    ]);

  // daemon
  const daemonPid = Number.parseInt(pidText, 10);
  const daemons = [...procs.values()].filter(
    (p) => p.args.trim() === "marmonitor" || /[/\\]bin[/\\]daemon\.js/.test(p.args),
  );
  if (!procs.has(daemonPid))
    flag(violations, "daemon", { reason: "pid file is not alive", daemonPid });
  if (daemons.length !== 1)
    flag(violations, "daemon", { reason: "daemon count", pids: daemons.map((d) => d.pid) });
  if (!snapshot || snapshotMtime === undefined || nowSec - snapshotMtime > 15) {
    flag(violations, "daemon", {
      reason: "snapshot stale",
      ageSec: snapshotMtime && Math.round(nowSec - snapshotMtime),
    });
  }
  const sessions = (snapshot ?? []).filter((a) => a.status !== "Dead" && procs.has(a.pid));
  const clis = groundTruthClis(procs);

  // counted helpers / missing CLIs
  for (const s of sessions) {
    const p = procs.get(s.pid);
    if (p.tty === "??" && s.runtimeSource !== "vscode") {
      flag(violations, "helperCounted", {
        pid: s.pid,
        agent: s.agentName,
        args: p.args.slice(0, 120),
      });
    }
  }
  const counted = new Set(sessions.map((s) => s.pid));
  for (const cli of clis.values()) {
    if (cli.childOf) continue;
    if (![...family(cli.pid, clis)].some((pid) => counted.has(pid))) {
      flag(violations, "cliMissing", {
        pid: cli.pid,
        agent: cli.agent,
        tty: cli.tty,
        args: cli.args.slice(0, 120),
      });
    }
  }

  // shared sessions
  const bySession = new Map();
  for (const s of sessions) {
    if (!s.sessionId) continue;
    bySession.set(s.sessionId, [...(bySession.get(s.sessionId) ?? []), s.pid]);
  }
  for (const [sessionId, pids] of bySession) {
    if (pids.length > 1) flag(violations, "sharedSession", { sessionId, pids });
  }

  // stale bindings: the bound file predates the process, while an unclaimed
  // file in the same cwd has been written since the process started.
  const claimed = new Set(bySession.keys());
  for (const s of sessions) {
    if (!s.sessionId || (s.agentName !== "Claude Code" && s.agentName !== "Codex")) continue;
    const started = s.processStartedAt ?? procs.get(s.pid).startedAt;
    const boundPath =
      s.agentName === "Codex"
        ? rollouts.get(s.sessionId)
        : join(claudeProjectDir(s.cwd), `${s.sessionId}.jsonl`);
    const boundMtime = boundPath && (await mtimeSec(boundPath));
    if (boundMtime === undefined || boundMtime >= started - START_SLACK_SEC) continue;
    const newer = [];
    for (const f of await sessionFiles(s.agentName, s.cwd, rollouts)) {
      if (claimed.has(f.id)) continue;
      const m = await mtimeSec(f.path);
      if (m === undefined || m < started - START_SLACK_SEC) continue;
      if (s.agentName === "Codex" && (await fileCwd("Codex", f.path)) !== s.cwd) continue;
      newer.push(f.id);
    }
    const detail = {
      pid: s.pid,
      agent: s.agentName,
      bound: s.sessionId,
      boundLastWrite: new Date(boundMtime * 1000).toISOString(),
      processStarted: new Date(started * 1000).toISOString(),
    };
    if (newer.length > 0) flag(violations, "staleBinding", { ...detail, candidates: newer });
    else flag(warnings, "staleBinding", { ...detail, reason: "bound file untouched since start" });
  }

  // Claude pid.json authority
  for (const s of sessions.filter((a) => a.agentName === "Claude Code")) {
    const meta = await readJson(join(claudeHome, "sessions", `${s.pid}.json`));
    if (!meta?.procStart || !meta.sessionId) continue;
    const owned =
      Math.abs(Date.parse(`${meta.procStart} UTC`) / 1000 - procs.get(s.pid).startedAt) <= 2;
    if (owned && meta.sessionId !== s.sessionId) {
      flag(violations, "pidJson", { pid: s.pid, snapshot: s.sessionId, pidJson: meta.sessionId });
    }
  }

  // Codex inferred activity
  for (const s of sessions.filter((a) => a.agentName === "Codex" && a.sessionId)) {
    const m = rollouts.has(s.sessionId) ? await mtimeSec(rollouts.get(s.sessionId)) : undefined;
    if (m === undefined) continue;
    if (s.observedActivityAt && s.observedActivityAt > m + START_SLACK_SEC) {
      flag(violations, "inferredActivity", {
        pid: s.pid,
        reason: "observed after file mtime",
        observed: s.observedActivityAt,
        mtime: m,
      });
    }
    if (
      s.lastActivityAt > m + INFERRED_TTL_SEC + 60 &&
      nowSec - s.lastActivityAt > INFERRED_TTL_SEC + 60
    ) {
      flag(violations, "inferredActivity", {
        pid: s.pid,
        reason: "inference outlived TTL",
        lastActivityAt: s.lastActivityAt,
        mtime: m,
      });
    }
  }

  // unmatched persistence
  const unmatchedSince = {};
  for (const s of sessions.filter((a) => a.status === "Unmatched")) {
    const key = `${s.pid}:${procs.get(s.pid).startedAt}`;
    unmatchedSince[key] = state.unmatchedSince[key] ?? nowSec;
    if (nowSec - unmatchedSince[key] > 600) {
      flag(violations, "unmatchedStuck", {
        pid: s.pid,
        agent: s.agentName,
        minutes: Math.round((nowSec - unmatchedSince[key]) / 60),
      });
    }
  }

  // statusline
  const badgeText = await run("marmonitor", ["--statusline", "--statusline-format", "tmux-badges"]);
  const { counts, pills } = parseBadges(badgeText);
  const seen = new Map();
  for (const pill of pills) {
    const key = `${pill.agent} ${pill.label}`;
    if (seen.has(key))
      flag(violations, "duplicateLabel", { label: key, indexes: [seen.get(key), pill.index] });
    seen.set(key, pill.index);
  }
  const truth = { Cl: 0, Cx: 0, Gm: 0 };
  for (const cli of clis.values()) {
    if (cli.childOf) continue;
    truth[{ "Claude Code": "Cl", Codex: "Cx", Gemini: "Gm" }[cli.agent]]++;
  }
  for (const [short, expected] of Object.entries(truth)) {
    const actual = counts[short] ?? 0;
    if (actual !== expected)
      flag(violations, "badgeCount", { agent: short, statusline: actual, terminalClis: expected });
  }

  // tmux pane mapping by process ancestry
  const paneByPid = new Map(panes.map((p) => [p.pid, p]));
  const paneTtys = new Set(panes.map((p) => basename(p.tty ?? "")));
  const byPane = new Map();
  for (const s of sessions) {
    const p = procs.get(s.pid);
    if (!paneTtys.has(p.tty)) continue; // not running inside tmux
    let cur = p;
    let pane;
    for (let hops = 0; cur && hops < 32 && !pane; hops++) {
      pane = paneByPid.get(cur.pid);
      cur = procs.get(cur.ppid);
    }
    if (!pane)
      flag(violations, "paneMapping", { pid: s.pid, reason: "tmux tty without owning pane" });
    else byPane.set(pane.id, [...(byPane.get(pane.id) ?? []), s.pid]);
  }
  for (const [pane, pids] of byPane)
    if (pids.length > 1) flag(warnings, "paneMapping", { pane, pids, reason: "pane shared" });

  // registry growth
  const records =
    registry && typeof registry === "object" ? Object.values(registry.sessions ?? registry) : [];
  const maxHistory = Math.max(
    0,
    ...records.map((r) => (Array.isArray(r?.history) ? r.history.length : 0)),
  );
  if (maxHistory > 500) flag(violations, "registryGrowth", { maxHistory });

  await writeFile(join(outDir, "state.json"), JSON.stringify({ unmatchedSince }));
  return {
    at: new Date().toISOString(),
    daemonPid,
    sessions: sessions.length,
    terminalClis: truth,
    statusline: counts,
    maxHistory,
    violations,
    warnings,
  };
}

async function summary() {
  const lines = (await readFile(join(outDir, "soak.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean);
  const runs = lines.map((l) => JSON.parse(l));
  if (runs.length === 0) return console.log(`No runs in ${outDir}`);
  const perCheck = Object.fromEntries(
    Object.keys(CHECKS).map((k) => [k, { runs: 0, first: null, last: null, example: null }]),
  );
  const daemonPids = new Set();
  for (const r of runs) {
    daemonPids.add(r.daemonPid);
    for (const k of new Set(r.violations.map((v) => v.check))) {
      const c = perCheck[k];
      c.runs++;
      c.first ??= r.at;
      c.last = r.at;
      c.example ??= r.violations.find((v) => v.check === k);
    }
  }
  console.log(
    `Soak ${runs[0].at} → ${runs.at(-1).at}  runs=${runs.length}  daemon PIDs=${[...daemonPids].join(",")}`,
  );
  for (const [k, desc] of Object.entries(CHECKS)) {
    const c = perCheck[k];
    console.log(
      `${c.runs === 0 ? "PASS" : "FAIL"}  ${k.padEnd(17)} ${desc}${c.runs ? `  (${c.runs} runs, ${c.first} … ${c.last})` : ""}`,
    );
    if (c.example) console.log(`      e.g. ${JSON.stringify(c.example)}`);
  }
}

await mkdir(outDir, { recursive: true });
if (args.includes("--summary")) {
  await summary();
} else {
  const result = await check();
  await appendFile(join(outDir, "soak.jsonl"), `${JSON.stringify(result)}\n`);
  for (const [k, desc] of Object.entries(CHECKS)) {
    const hits = result.violations.filter((v) => v.check === k);
    console.log(`${hits.length ? "FAIL" : "PASS"}  ${k.padEnd(17)} ${desc}`);
    for (const v of hits) console.log(`      ${JSON.stringify(v)}`);
  }
  for (const w of result.warnings) console.log(`WARN  ${JSON.stringify(w)}`);
  process.exitCode = result.violations.length ? 1 : 0;
}

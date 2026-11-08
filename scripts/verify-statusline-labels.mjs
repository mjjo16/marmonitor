// Exercise real tmux/PID mapping using an isolated socket and harmless sleep
// processes. Never create, select or terminate panes on the user's tmux server.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildTmuxAttentionPills } from "../dist/output/utils.js";
import { listTmuxPanes, resolveAgentTmuxTargets } from "../dist/tmux/index.js";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "mm-labels-"));
// Keep the UNIX socket under /tmp: macOS sockaddr_un has a short path limit.
const socketRoot = await mkdtemp("/tmp/mm-socket-");
const socket = join(socketRoot, "tmux.sock");
const originalTmux = process.env.TMUX;
const livePidPath = join(tmpdir(), "marmonitor", "daemon.pid");
const liveConfigPath = join(homedir(), ".tmux.conf");
const beforePid = await readFile(livePidPath, "utf8").catch(() => undefined);
const beforeConfig = await readFile(liveConfigPath, "utf8").catch(() => undefined);
const tmux = async (...args) =>
  (await exec("tmux", ["-S", socket, ...args], { timeout: 5000 })).stdout;
try {
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", "labels", "-c", root, "sleep 120");
  await tmux("split-window", "-d", "-t", "labels:0", "-c", root, "sleep 120");
  process.env.TMUX = `${socket},0,0`;
  const panes = await listTmuxPanes();
  assert.equal(panes.length, 2);
  const items = panes.map((pane) => ({
    pid: pane.panePid,
    cwd: root,
    agentName: "Claude Code",
    kind: "active",
    priority: 3,
    status: "Idle",
  }));
  const targets = await resolveAgentTmuxTargets(items);
  assert.equal(targets.size, 2);
  for (const item of items) assert.equal(targets.get(item.pid)?.match, "pid-tree");
  const before = buildTmuxAttentionPills(items, 5, undefined, "text", undefined, {
    tmuxTargets: targets,
  });
  for (const pane of panes)
    assert.ok(before.includes(`@labels:${pane.windowIndex}.${pane.paneIndex}`));
  // Renaming changes display coordinates while process and pane identity stay.
  await tmux("rename-session", "-t", "labels", "renamed");
  const renamedTargets = await resolveAgentTmuxTargets(items);
  const after = buildTmuxAttentionPills(items, 5, undefined, "text", undefined, {
    tmuxTargets: renamedTargets,
  });
  assert.ok(after.includes("@renamed:"));
  assert.ok(!after.includes("@labels:"));
  assert.deepEqual(
    [...renamedTargets.values()].map((t) => t.pane.paneId).sort(),
    panes.map((p) => p.paneId).sort(),
  );
  const movedPaneId = panes[1].paneId;
  await tmux("break-pane", "-d", "-s", movedPaneId, "-n", "moved");
  const movedTargets = await resolveAgentTmuxTargets(items);
  const moved = buildTmuxAttentionPills(items, 5, undefined, "text", undefined, {
    tmuxTargets: movedTargets,
  });
  assert.equal(movedTargets.get(items[1].pid)?.pane.paneId, movedPaneId);
  assert.notEqual(
    movedTargets.get(items[1].pid)?.pane.windowIndex,
    renamedTargets.get(items[1].pid)?.pane.windowIndex,
  );
  for (const location of movedTargets.values()) {
    await tmux("select-pane", "-t", location.pane.paneId);
    const selected = (
      await tmux(
        "display-message",
        "-p",
        "-t",
        `${location.pane.sessionName}:${location.pane.windowIndex}`,
        "#{pane_id}",
      )
    ).trim();
    assert.equal(selected, location.pane.paneId);
  }
  await writeFile(join(root, "before.txt"), before);
  await writeFile(join(root, "after.txt"), after);
  await writeFile(join(root, "moved.txt"), moved);
  console.log(
    JSON.stringify(
      {
        sameCwdSessions: items.length,
        verifiedTargets: targets.size,
        renameVerified: true,
        paneMoveVerified: true,
        fixturePaneSelectionVerified: true,
        artifacts: root,
      },
      null,
      2,
    ),
  );
  console.log(before.replace(/#\[[^\]]*\]/g, ""));
  console.log(after.replace(/#\[[^\]]*\]/g, ""));
  console.log(moved.replace(/#\[[^\]]*\]/g, ""));
} finally {
  // Only the fixture's explicit socket can be terminated here.
  await tmux("kill-server").catch(() => {});
  await rm(socketRoot, { recursive: true, force: true }).catch(() => {});
  if (originalTmux === undefined) Reflect.deleteProperty(process.env, "TMUX");
  else process.env.TMUX = originalTmux;
  assert.equal(await readFile(livePidPath, "utf8").catch(() => undefined), beforePid);
  assert.equal(await readFile(liveConfigPath, "utf8").catch(() => undefined), beforeConfig);
  console.log("Installed daemon PID and user tmux configuration unchanged.");
}

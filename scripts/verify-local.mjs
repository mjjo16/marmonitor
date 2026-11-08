// Read real processes and session files without replacing the installed daemon.
// All verification artifacts go into a fresh temporary directory.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import psList from "ps-list";
import { loadConfig } from "../dist/config/index.js";
import { renderStatusline } from "../dist/output/index.js";
import { scanAgents } from "../dist/scanner/index.js";
import { partitionSessions } from "../dist/sessions.js";

function summary(agents, deployed = false) {
  const { running, matched, unmatched } = partitionSessions(agents);
  const counted = deployed ? matched : running;
  return {
    total: counted.length,
    claude: counted.filter((a) => a.agentName === "Claude Code").length,
    codex: counted.filter((a) => a.agentName === "Codex").length,
    gemini: counted.filter((a) => a.agentName === "Gemini").length,
    unmatched: unmatched.length,
  };
}

const daemonDir = join(tmpdir(), "marmonitor");
const deployedPid = await readFile(join(daemonDir, "daemon.pid"), "utf8").catch(() => undefined);
const deployed = await readFile(join(daemonDir, "daemon-snapshot.json"), "utf8")
  .then(JSON.parse)
  .catch(() => undefined);
const config = await loadConfig();
const codexBindingRegistry = new Map();
const sessionRegistry = new Map();
const full = await scanAgents(config, {
  enrichmentMode: "full",
  codexBindingRegistry,
  sessionRegistry,
});
const light = await scanAgents(config, {
  enrichmentMode: "light",
  codexBindingRegistry,
  sessionRegistry,
});
const fullPids = full.map((a) => a.pid).sort((a, b) => a - b);
const lightPids = light.map((a) => a.pid).sort((a, b) => a - b);
const stable = JSON.stringify(fullPids) === JSON.stringify(lightPids);
if (stable) assert.deepEqual(summary(light), summary(full), "light/full counts must agree");
const processes = await psList();
const localPids = new Set(fullPids);
const removed = (deployed ?? [])
  .filter((a) => a.status !== "Dead" && !localPids.has(a.pid))
  .map((a) => ({
    pid: a.pid,
    name: processes.find((p) => p.pid === a.pid)?.name ?? "exited",
    previousStatus: a.status,
  }));
const currentPid = await readFile(join(daemonDir, "daemon.pid"), "utf8").catch(() => undefined);
assert.equal(currentPid, deployedPid, "installed daemon PID must remain unchanged");
const report = {
  checkedAt: new Date().toISOString(),
  deployed: Array.isArray(deployed) ? summary(deployed, true) : null,
  localFull: summary(full),
  localLight: summary(light),
  stableProcessSet: stable,
  daemonPidUnchangedDuringScan: currentPid === deployedPid,
  absentFromLocalScan: removed,
};
const outputDir = await mkdtemp(join(tmpdir(), "marmonitor-verify-"));
await writeFile(join(outputDir, "full-snapshot.json"), JSON.stringify(full, null, 2));
await writeFile(join(outputDir, "light-snapshot.json"), JSON.stringify(light, null, 2));
await writeFile(join(outputDir, "report.json"), JSON.stringify(report, null, 2));
const badges = await renderStatusline(full, "tmux-badges");
await writeFile(join(outputDir, "statusline.txt"), badges);
console.log(JSON.stringify(report, null, 2));
console.log(`Artifacts: ${outputDir}`);
console.log(`Preview: ${badges.replace(/#\[[^\]]*\]/g, "")}`);
if (!stable) console.log("Processes changed between scans; repeat to compare a stable set.");

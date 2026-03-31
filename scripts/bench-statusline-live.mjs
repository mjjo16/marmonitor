#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, rm, unlink } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { loadConfig } from "../dist/config/index.js";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(repoRoot, "bin", "marmonitor.js");
const cacheRoot = join(os.tmpdir(), "marmonitor");

function roundMs(value) {
  return Number(value.toFixed(1));
}

async function getGitValue(args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function getTmuxMetric(args) {
  try {
    const { stdout } = await execFileAsync("tmux", args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return {
      items: stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      error: undefined,
    };
  } catch {
    return {
      items: [],
      error: "tmux unavailable from current execution context",
    };
  }
}

function pickStep(perf, label, step) {
  return perf[label]?.steps?.[step];
}

function parsePerf(stderr, durationMs) {
  const result = {
    realMs: roundMs(durationMs),
    perf: {},
  };
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("MARMONITOR_PERF ")) continue;
    const payload = JSON.parse(line.slice("MARMONITOR_PERF ".length));
    result.perf[payload.label] = {
      totalMs: payload.totalMs,
      steps: Object.fromEntries((payload.steps ?? []).map((step) => [step.step, step.totalMs])),
    };
  }

  return {
    realMs: result.realMs,
    snapshotMs: pickStep(result.perf, "snapshot", "getAgentsSnapshot"),
    scanMs: pickStep(result.perf, "snapshot", "scanAgents"),
    psListMs: pickStep(result.perf, "scanAgents", "ps_list"),
    pidusageMs: pickStep(result.perf, "scanAgents", "pidusage"),
    buildSessionsMs: pickStep(result.perf, "scanAgents", "build_sessions"),
    lsofMs: pickStep(result.perf, "process", "lsof"),
    psLstartMs: pickStep(result.perf, "process", "ps_lstart"),
    stdoutMs: pickStep(result.perf, "stdout_heuristic", "detectCliStdoutPhase"),
    tmuxResolveMs: pickStep(result.perf, "tmux", "resolve_jump_target"),
    tmuxCaptureMs: pickStep(result.perf, "tmux", "capture_pane"),
    renderMs: pickStep(result.perf, "output", "renderStatusline"),
  };
}

async function runMarmonitor(args, env = {}) {
  return await new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const durationMs = performance.now() - startedAt;
      if (code !== 0) {
        reject(new Error(stderr || `marmonitor exited with code ${code}`));
        return;
      }
      resolve({
        stdout,
        stderr,
        durationMs,
      });
    });
  });
}

async function clearAllCaches() {
  await rm(cacheRoot, { recursive: true, force: true });
  await mkdir(cacheRoot, { recursive: true });
}

async function clearSnapshotArtifacts() {
  try {
    const entries = await readdir(cacheRoot);
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("snapshot-") || entry.startsWith("statusline-"))
        .map((entry) => unlink(join(cacheRoot, entry))),
    );
  } catch {
    // best effort only
  }
}

async function collectAgentCount(configPath) {
  try {
    const { stdout } = await runMarmonitor(
      ["status", "--json", ...(configPath ? ["--config", configPath] : [])],
      {},
    );
    const parsed = JSON.parse(stdout);
    const count = Array.isArray(parsed)
      ? parsed.length
      : Array.isArray(parsed?.agents)
        ? parsed.agents.length
        : undefined;
    return {
      count,
      error: count === undefined ? "status --json returned an unknown payload shape" : undefined,
    };
  } catch {
    return {
      count: undefined,
      error: "status --json collection failed",
    };
  }
}

function printHumanSummary(summary) {
  console.log("Statusline live benchmark");
  console.log(`current: ${summary.environment.currentCommit ?? "(unknown)"}`);
  if (summary.environment.baselineCommit) {
    console.log(`baseline: ${summary.environment.baselineCommit}`);
  }
  console.log(
    `host: ${summary.environment.cpuModel} | ${summary.environment.logicalCpuCount} logical CPU | ${summary.environment.totalMemoryGb} GB RAM`,
  );
  console.log(
    `tmux: ${summary.environment.tmuxSessionCount ?? "unavailable"} sessions | ${summary.environment.tmuxPaneCount ?? "unavailable"} panes | agents=${summary.environment.agentCount ?? "unknown"}`,
  );
  if (summary.environment.tmuxError) {
    console.log(`tmux access: ${summary.environment.tmuxError}`);
  }
  console.log(
    `ttl: snapshot=${summary.environment.snapshotTtlMs}ms statusline=${summary.environment.statuslineTtlMs}ms stdout=${summary.environment.stdoutHeuristicTtlMs}ms`,
  );
  console.log(`cold: ${summary.measurements.cold.realMs}ms`);
  console.log(`warm: ${summary.measurements.warm.realMs}ms`);
  for (const [index, measurement] of summary.measurements.forcedMiss.entries()) {
    console.log(
      `forced-miss #${index + 1}: ${measurement.realMs}ms (pidusage=${measurement.pidusageMs ?? "n/a"}ms, ps_list=${measurement.psListMs ?? "n/a"}ms)`,
    );
  }
  console.log("\nUse --json for machine-readable output.");
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      format: { type: "string", default: "compact" },
      width: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean", default: false },
      "forced-runs": { type: "string", default: "2" },
      "baseline-ref": { type: "string", default: "origin/main" },
    },
    allowPositionals: false,
  });

  const forcedRuns = Number(values["forced-runs"]);
  if (!Number.isInteger(forcedRuns) || forcedRuns <= 0) {
    throw new Error(`Invalid --forced-runs value: ${values["forced-runs"]}`);
  }

  const configPath = values.config ? String(values.config) : undefined;
  const config = await loadConfig(configPath);
  const statuslineArgs = [
    "--statusline",
    "--statusline-format",
    String(values.format),
    ...(values.width ? ["--width", String(values.width)] : []),
    ...(configPath ? ["--config", configPath] : []),
  ];

  await clearAllCaches();
  const cold = await runMarmonitor(statuslineArgs, { MARMONITOR_PERF: "1" });
  const warm = await runMarmonitor(statuslineArgs, { MARMONITOR_PERF: "1" });

  const forcedMiss = [];
  for (let i = 0; i < forcedRuns; i += 1) {
    await clearSnapshotArtifacts();
    const measurement = await runMarmonitor(statuslineArgs, { MARMONITOR_PERF: "1" });
    forcedMiss.push(parsePerf(measurement.stderr, measurement.durationMs));
  }

  const tmuxSessions = await getTmuxMetric(["ls"]);
  const tmuxPanes = await getTmuxMetric(["list-panes", "-a"]);
  const agentCount = await collectAgentCount(configPath);

  const summary = {
    environment: {
      currentCommit: await getGitValue(["rev-parse", "HEAD"]),
      baselineCommit: await getGitValue(["rev-parse", String(values["baseline-ref"])]),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      tmuxSessionCount: tmuxSessions.error ? null : tmuxSessions.items.length,
      tmuxPaneCount: tmuxPanes.error ? null : tmuxPanes.items.length,
      tmuxError: tmuxSessions.error ?? tmuxPanes.error,
      agentCount: agentCount.count ?? null,
      agentCountError: agentCount.error,
      snapshotTtlMs: config.performance.snapshotTtlMs,
      statuslineTtlMs: config.performance.statuslineTtlMs,
      stdoutHeuristicTtlMs: config.performance.stdoutHeuristicTtlMs,
    },
    measurements: {
      cold: parsePerf(cold.stderr, cold.durationMs),
      warm: parsePerf(warm.stderr, warm.durationMs),
      forcedMiss,
    },
  };

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHumanSummary(summary);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs, promisify } from "node:util";

import {
  codexSessionFileCache,
  codexSessionRegistry,
  setCodexIndexCache,
} from "../dist/scanner/cache.js";
import { indexCodexSessions } from "../dist/scanner/codex.js";

const execFileAsync = promisify(execFile);

const PROFILES = {
  heavy: {
    label: "long-tail token sessions",
    noiseLines: 400,
    paddingBytes: 512,
  },
  compact: {
    label: "shorter compact sessions",
    noiseLines: 40,
    paddingBytes: 96,
  },
};

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * ratio)),
  );
  return sortedValues[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const averageMs = total / samples.length;
  return {
    runs: samples.length,
    minMs: Number(sorted[0].toFixed(1)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(1)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(1)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
    averageMs: Number(averageMs.toFixed(1)),
    samplesMs: samples.map((value) => Number(value.toFixed(1))),
  };
}

function resetCodexCaches() {
  setCodexIndexCache(undefined);
  codexSessionFileCache.clear();
  codexSessionRegistry.clear();
}

async function getGitCommit(revision) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", revision], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function createFixture(rootDir, fileCount, profileName) {
  const profile = PROFILES[profileName];
  const now = new Date("2026-03-31T10:00:00.000Z");
  const yyyy = now.getUTCFullYear().toString();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const sessionsRoot = join(rootDir, profileName, "sessions");
  const dayDir = join(sessionsRoot, yyyy, mm, dd);
  const padding = "x".repeat(profile.paddingBytes);

  await mkdir(dayDir, { recursive: true });

  for (let i = 0; i < fileCount; i += 1) {
    const timestamp = new Date(now.getTime() + i * 1_000).toISOString();
    const cwd = `/tmp/marmonitor-bench/${profileName}/repo-${String(i).padStart(2, "0")}`;
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: `${profileName}-session-${i}`,
          cwd,
          timestamp,
          model_provider: "gpt-5.4",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        payload: {
          model: "gpt-5.4",
        },
      }),
    ];

    for (let line = 0; line < profile.noiseLines; line += 1) {
      lines.push(
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "progress",
            index: line,
            padding,
          },
        }),
      );
    }

    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000 + i,
              cached_input_tokens: 200 + i,
              output_tokens: 300 + i,
              total_tokens: 1500 + i,
            },
          },
        },
      }),
    );

    await writeFile(join(dayDir, `${profileName}-${i}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  }

  return {
    codexSessions: [sessionsRoot],
    claudeProjects: [],
    claudeSessions: [],
    extraRoots: [],
  };
}

async function measureColdScenario({ runtimePaths, includeTokenUsage, repeats }) {
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    resetCodexCaches();
    const startedAt = performance.now();
    await indexCodexSessions(undefined, { includeTokenUsage, runtimePaths });
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
}

async function measureWarmFileCacheScenario({ runtimePaths, includeTokenUsage, repeats }) {
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    resetCodexCaches();
    await indexCodexSessions(undefined, { includeTokenUsage, runtimePaths });
    setCodexIndexCache(undefined);
    const startedAt = performance.now();
    await indexCodexSessions(undefined, { includeTokenUsage, runtimePaths });
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
}

function printHumanSummary(result) {
  console.log("Codex index benchmark");
  console.log(`commit: ${result.environment.currentCommit ?? "(unknown)"}`);
  if (result.environment.baselineCommit) {
    console.log(`baseline: ${result.environment.baselineCommit}`);
  }
  console.log(
    `host: ${result.environment.cpuModel} | ${result.environment.logicalCpuCount} logical CPU | ${result.environment.totalMemoryGb} GB RAM`,
  );
  console.log(
    `fixture: ${result.fixture.fileCount} files | profiles=${result.fixture.profiles.join(", ")} | repeats=${result.fixture.repeats}`,
  );

  for (const profile of result.results) {
    console.log(`\n[${profile.profile}] ${profile.label}`);
    for (const scenario of profile.scenarios) {
      const full = scenario.full.averageMs;
      const light = scenario.light.averageMs;
      const ratio = full > 0 ? Number((full / light).toFixed(1)) : 0;
      console.log(
        `  ${scenario.name}: full avg ${full}ms | light avg ${light}ms | ratio ${ratio}x`,
      );
    }
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      files: { type: "string", default: "40" },
      repeats: { type: "string", default: "5" },
      profiles: { type: "string", default: "heavy,compact" },
      json: { type: "boolean", default: false },
      "baseline-ref": { type: "string", default: "origin/main" },
    },
    allowPositionals: false,
  });

  const fileCount = Number(values.files);
  const repeats = Number(values.repeats);
  const profiles = String(values.profiles)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const invalidProfiles = profiles.filter((profile) => !(profile in PROFILES));
  if (!Number.isInteger(fileCount) || fileCount <= 0) {
    throw new Error(`Invalid --files value: ${values.files}`);
  }
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid --repeats value: ${values.repeats}`);
  }
  if (invalidProfiles.length > 0) {
    throw new Error(`Unknown profiles: ${invalidProfiles.join(", ")}`);
  }

  const rootDir = await mkdtemp(join(os.tmpdir(), "marmonitor-bench-codex-"));

  try {
    const results = [];
    for (const profile of profiles) {
      const runtimePaths = await createFixture(rootDir, fileCount, profile);
      const coldFull = await measureColdScenario({
        runtimePaths,
        includeTokenUsage: true,
        repeats,
      });
      const coldLight = await measureColdScenario({
        runtimePaths,
        includeTokenUsage: false,
        repeats,
      });
      const warmFull = await measureWarmFileCacheScenario({
        runtimePaths,
        includeTokenUsage: true,
        repeats,
      });
      const warmLight = await measureWarmFileCacheScenario({
        runtimePaths,
        includeTokenUsage: false,
        repeats,
      });

      results.push({
        profile,
        label: PROFILES[profile].label,
        scenarios: [
          {
            name: "cold_empty_caches",
            full: coldFull,
            light: coldLight,
          },
          {
            name: "warm_file_cache",
            full: warmFull,
            light: warmLight,
          },
        ],
      });
    }

    const summary = {
      environment: {
        currentCommit: await getGitCommit("HEAD"),
        baselineCommit: await getGitCommit(String(values["baseline-ref"])),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        logicalCpuCount: os.cpus().length,
        totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      },
      fixture: {
        fileCount,
        repeats,
        profiles,
      },
      results,
    };

    if (values.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    printHumanSummary(summary);
    console.log("\nUse --json for machine-readable output.");
  } finally {
    resetCodexCaches();
    await rm(rootDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

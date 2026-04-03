/**
 * Daemon scan loop — runs in background, writes snapshots and registry to files.
 * Reuses watch/dock pattern: light scan every intervalMs, full every detailIntervalMs.
 */

import { unlink } from "node:fs/promises";
import type { MarmonitorConfig } from "../config/index.js";
import {
  type CodexBindingRegistry,
  loadCodexBindingRegistryFromFile,
  pruneCodexBindingRegistry,
  saveCodexBindingRegistryToFile,
} from "./codex-binding-registry.js";
import { writeDaemonPid, writeDaemonSnapshot } from "./daemon-utils.js";
import { scanAgents } from "./index.js";
import { perfEnd, perfStart } from "./perf.js";
import {
  loadRegistryFromFile,
  pruneRegistry,
  saveRegistryToFile,
  updateRegistry,
} from "./session-registry.js";
import type { SessionRegistryRecord } from "./session-registry.js";

export interface DaemonOptions {
  intervalMs: number;
  detailIntervalMs: number;
  snapshotPath: string;
  pidPath: string;
  registryPath: string;
  codexBindingRegistryPath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDaemonLoop(
  config: MarmonitorConfig,
  options: DaemonOptions,
): Promise<void> {
  const {
    intervalMs,
    detailIntervalMs,
    snapshotPath,
    pidPath,
    registryPath,
    codexBindingRegistryPath,
  } = options;

  await writeDaemonPid(pidPath, process.pid);

  const registry = new Map<string, SessionRegistryRecord>();
  const codexBindingRegistry: CodexBindingRegistry = new Map();

  // Restore registry if saved recently (within 10 minutes)
  try {
    const { stat: fsStat } = await import("node:fs/promises");
    const fileStat = await fsStat(registryPath);
    const ageMs = Date.now() - fileStat.mtimeMs;
    if (ageMs < 10 * 60 * 1000) {
      await loadRegistryFromFile(registryPath, registry);
    }
  } catch {
    // file missing or inaccessible — start fresh
  }
  await loadCodexBindingRegistryFromFile(codexBindingRegistryPath, codexBindingRegistry);

  let lastHeavyAt = 0;
  let running = true;

  const shutdown = async (): Promise<void> => {
    if (!running) return;
    running = false;
    // Save registry before exit
    await saveRegistryToFile(registryPath, registry);
    await saveCodexBindingRegistryToFile(codexBindingRegistryPath, codexBindingRegistry);
    await unlink(pidPath).catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Memory monitor: warn if RSS exceeds 200MB
  const RSS_WARN_MB = 200;
  let lastMemWarnAt = 0;

  while (running) {
    const now = Date.now();
    const needsHeavy = lastHeavyAt === 0 || now - lastHeavyAt >= detailIntervalMs;
    const enrichmentMode = needsHeavy ? "full" : "light";

    perfStart("daemon-scan");
    try {
      const agents = await scanAgents(config, {
        enrichmentMode,
        codexBindingRegistry,
      });
      if (needsHeavy) lastHeavyAt = now;

      // Update session registry
      updateRegistry(registry, agents);

      // Write snapshot for statusline consumers
      await writeDaemonSnapshot(snapshotPath, agents);

      // Save registry periodically (on heavy scan) + prune old entries
      if (needsHeavy) {
        pruneRegistry(registry, 30);
        await saveRegistryToFile(registryPath, registry);
        pruneCodexBindingRegistry(codexBindingRegistry, 7);
        await saveCodexBindingRegistryToFile(codexBindingRegistryPath, codexBindingRegistry);
      }
    } catch (err) {
      // scan failures must never crash the daemon
      process.stderr.write(`[marmonitor daemon] scan error: ${err}\n`);
    }
    perfEnd("daemon-scan");

    // Memory check
    const rssMb = process.memoryUsage.rss() / (1024 * 1024);
    if (rssMb > RSS_WARN_MB && now - lastMemWarnAt > 60_000) {
      process.stderr.write(
        `[marmonitor daemon] Warning: RSS ${Math.round(rssMb)}MB exceeds ${RSS_WARN_MB}MB\n`,
      );
      lastMemWarnAt = now;
    }

    await sleep(intervalMs);
  }
}

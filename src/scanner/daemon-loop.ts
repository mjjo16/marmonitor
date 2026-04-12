/**
 * Daemon scan loop — runs in background, writes snapshots and registry to files.
 * Reuses watch/dock pattern: light scan every intervalMs, full every detailIntervalMs.
 */

import { open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AlertStore,
  appendAlertLog,
  checkTokenAlert,
  sendDesktopNotification,
  writeAlertsSnapshot,
} from "../alerts/index.js";
import type { MarmonitorConfig } from "../config/index.js";
import {
  type ActivityEntry,
  appendActivityEntries,
  cleanupOldActivityLogs,
  extractClaudeToolUses,
  extractCodexToolUses,
  formatDateKey,
} from "./activity-log.js";
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
  alertsSnapshotPath: string;
  alertsLogPath: string;
  pidPath: string;
  registryPath: string;
  codexBindingRegistryPath: string;
  activityLogDir: string;
  activityRetentionDays: number;
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
    alertsSnapshotPath,
    alertsLogPath,
    pidPath,
    registryPath,
    codexBindingRegistryPath,
    activityLogDir,
    activityRetentionDays,
  } = options;

  // Activity log: per-session JSONL cursor offsets (in-memory only)
  const activityCursors = new Map<string, number>();
  let lastActivityCleanupAt = 0;

  const alertStore = new AlertStore();

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
        sessionRegistry: registry,
      });
      if (needsHeavy) lastHeavyAt = now;

      // Update session registry with lightweight agent metadata every scan.
      updateRegistry(registry, agents);

      // Write snapshot for statusline consumers
      await writeDaemonSnapshot(snapshotPath, agents);

      // Check token thresholds and fire alerts (alerts.enabled 확인)
      if (config.alerts.enabled) {
        const thresholds = {
          warnAt: config.alerts.contextWarnThreshold,
          critAt: config.alerts.contextCritThreshold,
        };
        for (const agent of agents) {
          const alert = checkTokenAlert(alertStore, agent, thresholds);
          if (alert) {
            if (config.alerts.log) await appendAlertLog(alertsLogPath, alert);
            if (config.alerts.desktop && alert.severity === "critical") {
              void sendDesktopNotification(alert); // fire-and-forget
            }
          }
        }
      }
      await writeAlertsSnapshot(alertsSnapshotPath, alertStore.active());

      // Save registry periodically (on heavy scan) + prune old entries
      if (needsHeavy) {
        pruneRegistry(registry, 30);
        await saveRegistryToFile(registryPath, registry);
        pruneCodexBindingRegistry(codexBindingRegistry, 7);
        await saveCodexBindingRegistryToFile(codexBindingRegistryPath, codexBindingRegistry);

        // Collect activity from session JSONLs (incremental cursor)
        const today = formatDateKey(new Date(now));
        const allEntries: ActivityEntry[] = [];
        const registryUpdates = [];

        for (const agent of agents) {
          if (!agent.sessionId) continue;
          // Find JSONL path from enrichment cache or registry
          const jsonlPath =
            agent.agentName === "Codex"
              ? codexBindingRegistry.get(`${agent.pid}:${agent.processStartedAt ?? 0}`)?.rolloutPath
              : undefined;

          // Claude: resolve JSONL path via resolveClaudeSessionFile (projects dir)
          let sessionFile: string | undefined;
          if (agent.agentName === "Claude Code" && agent.sessionId && agent.cwd) {
            const { resolveClaudeSessionFile } = await import("./claude.js");
            sessionFile = await resolveClaudeSessionFile(
              agent.sessionId,
              agent.cwd,
              agent.startedAt,
              config,
            );
          } else if (agent.agentName === "Codex" && jsonlPath) {
            sessionFile = jsonlPath;
          }

          if (!sessionFile) continue;
          registryUpdates.push({
            agentName: agent.agentName,
            pid: agent.pid,
            sessionId: agent.sessionId,
            cwd: agent.cwd,
            startedAt: agent.startedAt,
            tokenUsage: agent.tokenUsage,
            lastActivityAt: agent.lastActivityAt,
            model: agent.model,
            jsonlPath: sessionFile,
          });

          const cursorKey = sessionFile;
          const prevOffset = activityCursors.get(cursorKey) ?? 0;

          try {
            const fileStat = await stat(sessionFile);
            if (fileStat.size <= prevOffset) continue;

            const fd = await open(sessionFile, "r");
            try {
              const buf = Buffer.alloc(fileStat.size - prevOffset);
              await fd.read(buf, 0, buf.length, prevOffset);
              const chunk = buf.toString("utf-8");
              const lines = chunk.split("\n").filter(Boolean);

              const entries =
                agent.agentName === "Codex"
                  ? extractCodexToolUses(lines, agent.sessionId, agent.agentName, agent.cwd)
                  : extractClaudeToolUses(lines, agent.sessionId, agent.agentName, agent.cwd);

              allEntries.push(...entries);
              activityCursors.set(cursorKey, fileStat.size);
            } finally {
              await fd.close();
            }
          } catch {
            // JSONL read failure — skip this session
          }
        }

        if (allEntries.length > 0) {
          await appendActivityEntries(activityLogDir, today, allEntries);
        }
        if (registryUpdates.length > 0) {
          updateRegistry(registry, registryUpdates);
        }

        // Cleanup old activity logs (once per day)
        if (now - lastActivityCleanupAt > 86400000) {
          await cleanupOldActivityLogs(activityLogDir, activityRetentionDays);
          lastActivityCleanupAt = now;
        }
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

/**
 * Short-lived cross-process caches for process scans and pidusage.
 */

import pidusage from "pidusage";
import psList from "ps-list";

import { profileAsync } from "../perf.js";
import { readSharedCache, writeSharedCache } from "./shared-cache.js";

const PROCESS_LIST_SHARED_TTL_MS = 1_000;
const PIDUSAGE_SHARED_TTL_MS = 1_000;

type ProcessListEntry = Awaited<ReturnType<typeof psList>>[number];
type ProcessUsageMap = Record<number, { cpu: number; memory: number }>;

interface SharedSnapshotOptions {
  cacheRoot?: string;
  nowMs?: number;
}

interface ProcessListOptions extends SharedSnapshotOptions {
  psList?: typeof psList;
}

interface PidUsageOptions extends SharedSnapshotOptions {
  pidusage?: typeof pidusage;
}

function normalizeProcesses(processes: ProcessListEntry[]): ProcessListEntry[] {
  return processes.map((proc) => ({
    pid: proc.pid,
    ppid: proc.ppid,
    name: proc.name,
    cmd: proc.cmd,
  }));
}

function normalizePidUsage(usage: Awaited<ReturnType<typeof pidusage>>): ProcessUsageMap {
  const normalized: ProcessUsageMap = {};
  for (const [pid, stats] of Object.entries(usage)) {
    normalized[Number(pid)] = {
      cpu: stats.cpu,
      memory: stats.memory,
    };
  }
  return normalized;
}

export async function listProcessesCached(
  options: ProcessListOptions = {},
): Promise<ProcessListEntry[]> {
  const nowMs = options.nowMs ?? Date.now();
  const sharedCached = await readSharedCache<ProcessListEntry[]>(
    "process-list",
    "all",
    PROCESS_LIST_SHARED_TTL_MS,
    {
      cacheRoot: options.cacheRoot,
      nowMs,
    },
  );
  if (sharedCached) {
    return sharedCached.value;
  }

  const runPsList = options.psList ?? psList;
  const processes = await profileAsync("scanAgents", "ps_list", () => runPsList());
  const normalized = normalizeProcesses(processes);
  await writeSharedCache("process-list", "all", normalized, {
    cacheRoot: options.cacheRoot,
    nowMs,
  });
  return normalized;
}

export async function getPidUsageCached(
  pids: number[],
  options: PidUsageOptions = {},
): Promise<ProcessUsageMap> {
  const normalizedPids = [...new Set(pids)].sort((a, b) => a - b);
  if (normalizedPids.length === 0) return {};

  const nowMs = options.nowMs ?? Date.now();
  const sharedKey = normalizedPids.join(",");
  const sharedCached = await readSharedCache<ProcessUsageMap>(
    "pidusage",
    sharedKey,
    PIDUSAGE_SHARED_TTL_MS,
    {
      cacheRoot: options.cacheRoot,
      nowMs,
    },
  );
  if (sharedCached) {
    return sharedCached.value;
  }

  const runPidusage = options.pidusage ?? pidusage;
  const usage = await profileAsync("scanAgents", "pidusage", () => runPidusage(normalizedPids));
  const normalized = normalizePidUsage(usage);
  await writeSharedCache("pidusage", sharedKey, normalized, {
    cacheRoot: options.cacheRoot,
    nowMs,
  });
  return normalized;
}

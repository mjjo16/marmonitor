import { performance } from "node:perf_hooks";

type PerfStepStats = {
  totalMs: number;
  calls: number;
};

type PerfLabelStats = {
  startedAtMs: number;
  steps: Map<string, PerfStepStats>;
};

const PERF_ENABLED = (() => {
  const value = process.env.MARMONITOR_PERF?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "json" || value === "on";
})();

const perfBuckets = new Map<string, PerfLabelStats>();
let flushHookInstalled = false;

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function getBucket(label: string): PerfLabelStats {
  const existing = perfBuckets.get(label);
  if (existing) return existing;

  const created: PerfLabelStats = {
    startedAtMs: performance.now(),
    steps: new Map(),
  };
  perfBuckets.set(label, created);
  return created;
}

function record(label: string, step: string, elapsedMs: number): void {
  const bucket = getBucket(label);
  const entry = bucket.steps.get(step) ?? { totalMs: 0, calls: 0 };
  entry.totalMs += elapsedMs;
  entry.calls += 1;
  bucket.steps.set(step, entry);
}

function flushPerf(): void {
  if (!PERF_ENABLED || perfBuckets.size === 0) return;

  const buckets = [...perfBuckets.entries()].sort(
    (a, b) => bucketTotalMs(b[1]) - bucketTotalMs(a[1]),
  );

  for (const [label, bucket] of buckets) {
    const totalMs = roundMs(performance.now() - bucket.startedAtMs);
    const steps = [...bucket.steps.entries()]
      .map(([step, stats]) => ({
        step,
        totalMs: roundMs(stats.totalMs),
        calls: stats.calls,
        avgMs: roundMs(stats.totalMs / stats.calls),
      }))
      .sort((a, b) => b.totalMs - a.totalMs || a.step.localeCompare(b.step));

    process.stderr.write(
      `MARMONITOR_PERF ${JSON.stringify({
        label,
        totalMs,
        steps,
      })}\n`,
    );
  }

  perfBuckets.clear();
}

function bucketTotalMs(bucket: PerfLabelStats): number {
  let total = 0;
  for (const step of bucket.steps.values()) total += step.totalMs;
  return total;
}

function installFlushHook(): void {
  if (!PERF_ENABLED || flushHookInstalled) return;
  flushHookInstalled = true;
  process.once("beforeExit", flushPerf);
  process.once("SIGINT", () => {
    flushPerf();
  });
  process.once("SIGTERM", () => {
    flushPerf();
  });
}

export async function profileAsync<T>(
  label: string,
  step: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (!PERF_ENABLED) return await fn();

  installFlushHook();
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    record(label, step, performance.now() - startedAt);
  }
}

export function profileSync<T>(label: string, step: string, fn: () => T): T {
  if (!PERF_ENABLED) return fn();

  installFlushHook();
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    record(label, step, performance.now() - startedAt);
  }
}

export function isPerfEnabled(): boolean {
  return PERF_ENABLED;
}

/**
 * Performance instrumentation for marmonitor.
 * Enable with MARMONITOR_PERF=1 environment variable.
 * Outputs timing to stderr so it doesn't interfere with statusline output.
 */

const enabled = process.env.MARMONITOR_PERF === "1";
const timers = new Map<string, number>();

export function perfStart(label: string): void {
  if (!enabled) return;
  timers.set(label, performance.now());
}

export function perfEnd(label: string): number {
  if (!enabled) return 0;
  const start = timers.get(label);
  if (start === undefined) return 0;
  const elapsed = performance.now() - start;
  timers.delete(label);
  process.stderr.write(`[perf] ${label}: ${elapsed.toFixed(1)}ms\n`);
  return elapsed;
}

export function perfEnabled(): boolean {
  return enabled;
}

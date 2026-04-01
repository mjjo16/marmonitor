/**
 * Simple concurrency limiter for Promise.all replacement.
 * Limits how many tasks run in parallel to reduce CPU/IO spikes.
 */

export async function promiseAllLimited<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<(T | null)[]> {
  const results: (T | null)[] = new Array(tasks.length).fill(null);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      try {
        results[i] = await tasks[i]();
      } catch {
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

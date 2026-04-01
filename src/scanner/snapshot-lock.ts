/**
 * File-based snapshot refresh lock.
 * Prevents concurrent statusline processes from running duplicate scans.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function acquireSnapshotLock(lockPath: string, ttlMs: number): Promise<boolean> {
  try {
    const content = await readFile(lockPath, "utf-8").catch(() => null);
    if (content !== null) {
      const lockTime = Number(content.trim());
      if (!Number.isNaN(lockTime) && Date.now() - lockTime < ttlMs) {
        return false; // lock held and not expired
      }
    }
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, String(Date.now()), "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function releaseSnapshotLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // silent — lock file may already be gone
  }
}

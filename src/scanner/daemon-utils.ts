/**
 * Daemon utility functions for PID management and snapshot I/O.
 * Used by both the daemon loop and CLI commands.
 */

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeDaemonPid(pidPath: string, pid: number): Promise<void> {
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(pid), "utf-8");
}

export async function readDaemonPid(pidPath: string): Promise<number | undefined> {
  try {
    const content = await readFile(pidPath, "utf-8");
    const pid = Number.parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

export async function isDaemonRunning(pidPath: string): Promise<boolean> {
  const pid = await readDaemonPid(pidPath);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    // process doesn't exist — stale PID file
    await unlink(pidPath).catch(() => {});
    return false;
  }
}

export async function writeDaemonSnapshot(snapshotPath: string, data: unknown[]): Promise<void> {
  try {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, JSON.stringify(data), "utf-8");
  } catch {
    // snapshot write failures must never crash the daemon
  }
}

export async function readDaemonSnapshot(snapshotPath: string, ttlMs: number): Promise<unknown[]> {
  try {
    const fileStat = await stat(snapshotPath);
    if (Date.now() - fileStat.mtimeMs > ttlMs) return [];
    const raw = await readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write/read alerts snapshot alongside daemon snapshot */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Alert, AlertsSnapshot } from "./types.js";

export async function writeAlertsSnapshot(path: string, active: Alert[]): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const snap: AlertsSnapshot = { active, updatedAt: Date.now() };
    await writeFile(path, JSON.stringify(snap), "utf-8");
  } catch {
    // snapshot write failures must never crash callers
  }
}

export async function readAlertsSnapshot(path: string, ttlMs = 10_000): Promise<Alert[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const snap = JSON.parse(raw) as AlertsSnapshot;
    if (Date.now() - snap.updatedAt > ttlMs) return [];
    return snap.active ?? [];
  } catch {
    return [];
  }
}

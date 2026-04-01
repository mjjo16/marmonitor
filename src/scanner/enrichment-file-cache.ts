/**
 * File-based enrichment cache for cross-process sharing.
 * Prevents full scan spikes in one-shot statusline calls.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentSession } from "../types.js";

type EnrichmentData = Record<string, Partial<AgentSession>>;

export async function loadEnrichmentCache(
  cachePath: string,
  ttlMs: number,
): Promise<EnrichmentData> {
  try {
    const fileStat = await stat(cachePath);
    if (Date.now() - fileStat.mtimeMs > ttlMs) return {};
    const raw = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as EnrichmentData;
  } catch {
    return {};
  }
}

export async function saveEnrichmentCache(cachePath: string, data: EnrichmentData): Promise<void> {
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(data), "utf-8");
  } catch {
    // cache write failures must never break scanning
  }
}

/**
 * Small cross-process cache helpers backed by files under TMPDIR.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface SharedCacheRecord<T> {
  checkedAt: number;
  value: T;
}

interface SharedCacheOptions {
  cacheRoot?: string;
  nowMs?: number;
}

function resolveSharedCacheRoot(cacheRoot?: string): string {
  return cacheRoot ?? join(tmpdir(), "marmonitor", "shared");
}

function resolveSharedCachePath(namespace: string, key: string, cacheRoot?: string): string {
  const digest = createHash("sha1").update(`${namespace}:${key}`).digest("hex");
  return join(resolveSharedCacheRoot(cacheRoot), `${namespace}-${digest}.json`);
}

export async function readSharedCache<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  options: SharedCacheOptions = {},
): Promise<SharedCacheRecord<T> | undefined> {
  if (ttlMs <= 0) return undefined;
  const path = resolveSharedCachePath(namespace, key, options.cacheRoot);
  const nowMs = options.nowMs ?? Date.now();

  try {
    const fileStat = await stat(path);
    const raw = JSON.parse(await readFile(path, "utf-8")) as {
      checkedAt?: unknown;
      value?: T;
    };
    const checkedAt =
      typeof raw.checkedAt === "number" ? raw.checkedAt : Math.floor(fileStat.mtimeMs);
    if (nowMs - checkedAt > ttlMs) return undefined;
    return { checkedAt, value: raw.value as T };
  } catch {
    return undefined;
  }
}

export async function writeSharedCache<T>(
  namespace: string,
  key: string,
  value: T,
  options: SharedCacheOptions = {},
): Promise<void> {
  const path = resolveSharedCachePath(namespace, key, options.cacheRoot);
  const checkedAt = options.nowMs ?? Date.now();

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ checkedAt, value }), "utf-8");
  } catch {
    // cross-process cache failures must never break scanning
  }
}

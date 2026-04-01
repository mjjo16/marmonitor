/**
 * Daemon entry point — loaded by bin/daemon.js.
 * Starts the background scan loop with default paths.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/index.js";
import { getConfigDir } from "../config/index.js";
import { runDaemonLoop } from "./daemon-loop.js";

const DAEMON_DIR = join(tmpdir(), "marmonitor");
const CONFIG_DIR = getConfigDir();

async function main(): Promise<void> {
  process.title = "marmonitor";
  const config = await loadConfig();

  const intervalSec = Math.max(1, Math.min(30, Math.floor(config.performance.daemonIntervalSec)));
  await runDaemonLoop(config, {
    intervalMs: intervalSec * 1000,
    detailIntervalMs: 30_000,
    snapshotPath: join(DAEMON_DIR, "daemon-snapshot.json"),
    pidPath: join(DAEMON_DIR, "daemon.pid"),
    registryPath: join(CONFIG_DIR, "session-registry.json"),
  });
}

main().catch((err) => {
  process.stderr.write(`[marmonitor daemon] Fatal: ${err}\n`);
  process.exit(1);
});

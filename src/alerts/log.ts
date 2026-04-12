/** Append-only alert log writer → ~/.config/marmonitor/alerts.log */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Alert } from "./types.js";

export async function appendAlertLog(logPath: string, alert: Alert): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const ts = new Date(alert.createdAt).toISOString();
    const line = `${ts} [${alert.severity.toUpperCase()}] ${alert.type} pid=${alert.agentPid} ${alert.message}${alert.detail ? ` | ${alert.detail}` : ""}\n`;
    await appendFile(logPath, line, "utf-8");
  } catch {
    // log failures must never crash callers
  }
}

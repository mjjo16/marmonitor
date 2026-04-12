/** macOS / Linux desktop notification via node-notifier */

import type { Alert } from "./types.js";

const APP_NAME = "marmonitor";

function title(alert: Alert): string {
  switch (alert.type) {
    case "context_critical":
      return "⚠️ Context Critical";
    case "context_warn":
      return "Context Warning";
    case "security":
      return "🚨 Security Alert";
  }
}

export async function sendDesktopNotification(alert: Alert): Promise<void> {
  try {
    // Dynamic import — node-notifier is optional; fail silently if missing
    const notifier = await import("node-notifier");
    const message = alert.detail ? `${alert.message}\n${alert.detail}` : alert.message;
    notifier.default.notify({ title: title(alert), message });
  } catch {
    // node-notifier unavailable or notification failed — silent
  }
}

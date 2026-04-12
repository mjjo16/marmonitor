/** Alert system types for marmonitor */

export type AlertType =
  | "context_warn" // token 70% threshold
  | "context_critical" // token 85%+ threshold
  | "security"; // dangerous command detected

export type AlertSeverity = "info" | "warn" | "critical";

export interface Alert {
  /** Deterministic dedup ID: `type:agentPid:bucket` */
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  agentPid: number;
  sessionId?: string;
  cwd?: string;
  message: string;
  /** Extra context: token count, command, etc. */
  detail?: string;
  createdAt: number; // unix ms
  dismissedAt?: number;
  expiresAt?: number;
}

/** Snapshot of active alerts written alongside agent snapshot */
export interface AlertsSnapshot {
  active: Alert[];
  updatedAt: number; // unix ms
}

/** In-memory AlertStore with dedup and auto-expiry */

import type { Alert, AlertSeverity, AlertType } from "./types.js";

/** 5-minute dedup bucket (ms) */
const DEDUP_BUCKET_MS = 5 * 60 * 1000;

function makeBucket(createdAt: number): number {
  return Math.floor(createdAt / DEDUP_BUCKET_MS);
}

function makeId(type: AlertType, agentPid: number, bucket: number): string {
  return `${type}:${agentPid}:${bucket}`;
}

export interface CreateAlertOptions {
  type: AlertType;
  severity: AlertSeverity;
  agentPid: number;
  message: string;
  sessionId?: string;
  cwd?: string;
  detail?: string;
  /** ms until auto-expiry. Defaults: security=0 (manual), context=5min */
  ttlMs?: number;
}

export class AlertStore {
  private alerts = new Map<string, Alert>();

  /** Create and store an alert. Returns the alert if new, undefined if duplicate. */
  create(opts: CreateAlertOptions): Alert | undefined {
    const now = Date.now();
    const bucket = makeBucket(now);
    const id = makeId(opts.type, opts.agentPid, bucket);

    if (this.alerts.has(id)) return undefined;

    const ttlMs = opts.ttlMs ?? (opts.type === "security" ? 0 : DEDUP_BUCKET_MS);
    const alert: Alert = {
      id,
      type: opts.type,
      severity: opts.severity,
      agentPid: opts.agentPid,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      message: opts.message,
      detail: opts.detail,
      createdAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : undefined,
    };

    this.alerts.set(id, alert);
    return alert;
  }

  dismiss(id: string): void {
    const alert = this.alerts.get(id);
    if (alert) {
      alert.dismissedAt = Date.now();
      this.alerts.delete(id);
    }
  }

  /** Prune expired and dismissed alerts */
  prune(): void {
    const now = Date.now();
    for (const [id, alert] of this.alerts) {
      if (alert.dismissedAt) {
        this.alerts.delete(id);
      } else if (alert.expiresAt && now > alert.expiresAt) {
        this.alerts.delete(id);
      }
    }
  }

  active(): Alert[] {
    this.prune();
    return [...this.alerts.values()];
  }

  count(): number {
    return this.active().length;
  }
}

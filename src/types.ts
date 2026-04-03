/** Token usage data */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

/** Agent session status */
export type SessionStatus = "Active" | "Idle" | "Stalled" | "Unmatched" | "Dead";

/** Agent activity phase (what the AI is doing right now) */
export type SessionPhase = "thinking" | "tool" | "permission" | "done" | undefined;

/** Runtime source / host environment */
export type RuntimeSource = "cli" | "vscode" | "unknown";

/** Child/worker process info */
export interface WorkerProcess {
  pid: number;
  cpuPercent: number;
  memoryMb: number;
  status: SessionStatus;
}

/** Detected AI agent session */
export interface AgentSession {
  agentName: string;
  pid: number;
  ppid?: number;
  cwd: string;
  cpuPercent: number;
  memoryMb: number;
  status: SessionStatus;
  startedAt?: number; // epoch seconds
  processStartedAt?: number; // epoch seconds — OS process start time
  sessionId?: string;
  lastActivity?: string;
  tokenUsage?: TokenUsage;
  model?: string;
  workers?: WorkerProcess[];
  sessionMatched?: boolean; // true if matched to a session file
  phase?: SessionPhase; // current activity phase
  lastResponseAt?: number; // epoch seconds — last AI response
  lastActivityAt?: number; // epoch seconds — last any event
  runtimeSource?: RuntimeSource;
}

/** Agent detection signature */
export interface AgentSignature {
  processNames: string[];
  sessionDir: string;
}

/** System resource snapshot */
export interface SystemInfo {
  cpuPercent: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  batteryPercent?: number;
  batteryCharging?: boolean;
}

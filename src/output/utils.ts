import type { AgentSession, SessionPhase } from "../types.js";
import { renderAttention, renderBadge, renderFocus, resolveTheme } from "./badge-themes.js";

/**
 * Pure utility functions for marmonitor.
 * Extracted for testability — no side effects, no I/O.
 */

/** Shorten home directory path with ~ */
export function shortenPath(path: string, home?: string): string {
  const h = home ?? process.env.HOME ?? "";
  return path.startsWith(h) ? `~${path.slice(h.length)}` : path;
}

/** Format elapsed time from epoch seconds to human-readable */
export function formatElapsed(epochSec?: number, now?: number): string {
  if (!epochSec) return "?";
  const current = now ?? Date.now() / 1000;
  const elapsed = current - epochSec;
  if (elapsed < 0) return "?";
  if (elapsed < 60) return `${Math.floor(elapsed)}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
}

/** Compact elapsed label for status bars/popups.
 *  e.g. 26s, 3m, 2h, 1d */
export function formatElapsedCompact(epochSec?: number, now?: number): string | undefined {
  if (!epochSec) return undefined;
  const current = now ?? Date.now() / 1000;
  const elapsed = current - epochSec;
  if (elapsed < 0) return undefined;
  if (elapsed < 60) return `${Math.floor(elapsed)}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`;
  return `${Math.floor(elapsed / 86400)}d`;
}

/** Format token count (e.g. 1234 -> "1.2K", 1234567 -> "1.2M") */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Compact directory label for dock/focus display.
 *  Replaces $HOME with ~ first, then shows last 2 path segments.
 *  e.g. "/Users/macrent" → "~"
 *       "/Users/macrent/marmonitor" → "~/marmonitor"
 *       "/Users/macrent/Documents/vos/vos-data-service" → "vos/vos-data-service"
 *       "/Users/macrent/.ai/projects/vos" → "projects/vos" */
export function compactDirLabel(cwd: string): string {
  const home = process.env.HOME ?? "";
  const shortened = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (shortened === "~") return "~";
  const parts = shortened.split("/").filter(Boolean);
  if (parts.length <= 1) return parts[0] || cwd;
  return parts.slice(-2).join("/");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  if (maxLength <= 3) return `${value.slice(0, maxLength - 1)}…`;
  const head = Math.ceil((maxLength - 1) / 2);
  const tail = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Compact directory label for narrow statusline surfaces.
 *  Preserves the last repo segment most aggressively and shortens parent first. */
export function compactStatuslineDirLabel(cwd: string, maxLength = 26): string {
  const label = compactDirLabel(cwd);
  if (label.length <= maxLength) return label;

  const [parent, base] = label.split("/", 2);
  if (!base) return truncateMiddle(label, maxLength);
  const parentLabel = parent.slice(0, 1);
  const baseBudget = maxLength - parentLabel.length - 1;
  return `${parentLabel}/${truncateMiddle(base, baseBudget)}`;
}

export interface StatuslineDetailLayout {
  itemCount: number;
  pathMaxLength: number;
}

export function resolveStatuslineDetailLayout(
  width: number | undefined,
  maxCount: number,
): StatuslineDetailLayout {
  if (!width || width <= 0) {
    return { itemCount: maxCount, pathMaxLength: 26 };
  }

  if (width < 70) {
    return { itemCount: Math.min(maxCount, 1), pathMaxLength: 12 };
  }
  if (width < 90) {
    return { itemCount: Math.min(maxCount, 2), pathMaxLength: 14 };
  }
  if (width < 120) {
    return { itemCount: Math.min(maxCount, 3), pathMaxLength: 16 };
  }
  if (width < 150) {
    return { itemCount: Math.min(maxCount, 4), pathMaxLength: 20 };
  }

  return { itemCount: maxCount, pathMaxLength: 26 };
}

/** Encode cwd to Claude project directory name.
 *  Claude Code replaces both "/" and "." with "-". */
export function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Determine agent status from CPU, elapsed time, and session match state */
export function determineStatus(
  cpuPercent: number,
  elapsedSec: number | undefined,
  sessionMatched: boolean,
  activeCpuThreshold: number,
  stalledAfterMin: number,
  phase?: SessionPhase,
  recentActivityActiveSec = 180,
): "Active" | "Idle" | "Stalled" | "Unmatched" | "Dead" {
  if (!sessionMatched) return "Unmatched";
  if (cpuPercent > activeCpuThreshold) return "Active";
  if (
    (phase === "thinking" || phase === "tool" || phase === "permission") &&
    (elapsedSec === undefined || elapsedSec <= recentActivityActiveSec)
  ) {
    return "Active";
  }
  const stalledSec = stalledAfterMin * 60;
  if (elapsedSec !== undefined && elapsedSec > stalledSec && cpuPercent < 0.1) {
    return "Stalled";
  }
  return "Idle";
}

export interface CodexSessionCandidate {
  cwd: string;
  timestamp: number;
}

/** Select the most plausible Codex session for a process.
 *  Prefer exact cwd match, then nearest timestamp; otherwise most recent. */
export function selectCodexSession<T extends CodexSessionCandidate>(
  processCwd: string,
  processStartTime: number | undefined,
  sessions: T[],
): T | undefined {
  const cwdMatches = sessions.filter((session) => session.cwd === processCwd);
  if (cwdMatches.length === 0) return undefined;
  if (cwdMatches.length === 1) return cwdMatches[0];

  const sorted = [...cwdMatches];
  if (processStartTime !== undefined) {
    sorted.sort(
      (a, b) => Math.abs(a.timestamp - processStartTime) - Math.abs(b.timestamp - processStartTime),
    );
  } else {
    sorted.sort((a, b) => b.timestamp - a.timestamp);
  }

  return sorted[0];
}

/** Select unmatched processes that are eligible for cleanup. */
export function selectUnmatchedTargets(
  agents: AgentSession[],
  selectedPids?: number[],
): AgentSession[] {
  const unmatched = agents.filter((agent) => agent.status === "Unmatched");
  if (!selectedPids || selectedPids.length === 0) {
    return unmatched.sort((a, b) => a.pid - b.pid);
  }

  const selected = new Set(selectedPids);
  return unmatched.filter((agent) => selected.has(agent.pid)).sort((a, b) => a.pid - b.pid);
}

export interface StatuslineSnapshot {
  aliveCount: number;
  waitingCount: number;
  riskCount: number;
  stalledCount: number;
  unmatchedCount: number;
  activeCount: number;
  highCpuCount: number;
  thinkingCount?: number;
  toolCount?: number;
  claudeCount?: number;
  codexCount?: number;
  geminiCount?: number;
  cpuPercent?: number;
  memoryUsedGb?: number;
}

export type StatuslineFormat =
  | "compact"
  | "standard"
  | "extended"
  | "tmux-badges"
  | "wezterm-pills";

export type AttentionKind = "unmatched" | "permission" | "stalled" | "thinking" | "tool" | "active";

export interface AttentionItem {
  kind: AttentionKind;
  priority: number;
  pid: number;
  agentName: string;
  cwd: string;
  cpuPercent?: number;
  memoryMb?: number;
  startedAt?: number;
  runtimeSource?: AgentSession["runtimeSource"];
  status: AgentSession["status"];
  phase?: AgentSession["phase"];
  lastResponseAt?: number;
  lastActivityAt?: number;
}

export interface StatusPill {
  label: string;
  fg: string;
  bg: string;
}

export interface PhaseDecayConfig {
  thinking: number;
  tool: number;
  permission: number;
  done: number;
}

export interface JsonlCursorState {
  offset: number;
  remainder: string;
  recentLines: string[];
}

export interface PhaseHistoryEntry {
  phase: Exclude<SessionPhase, undefined>;
  at: number;
}

export interface SessionRegistryEntry {
  filePath: string;
  sessionId: string;
  cwd: string;
  firstSeenOffset: number;
  startedAt?: number;
  model?: string;
  source: "claude" | "codex";
}

export interface SessionFileCandidate {
  path: string;
  mtimeMs: number;
}

export function resolvePhaseWithDecay(
  currentPhase: SessionPhase,
  cachedPhase: SessionPhase,
  cachedDetectedAtMs: number | undefined,
  decay: PhaseDecayConfig,
  nowMs = Date.now(),
): SessionPhase {
  if (currentPhase) return currentPhase;
  if (!cachedPhase || cachedDetectedAtMs === undefined) return undefined;

  const decaySec = decay[cachedPhase];
  if (decaySec === 0) return cachedPhase;
  if (nowMs - cachedDetectedAtMs <= decaySec * 1000) return cachedPhase;
  return undefined;
}

export function advanceJsonlCursor(
  previous: JsonlCursorState,
  chunk: string,
  maxLines: number,
): JsonlCursorState {
  const merged = previous.remainder + chunk;
  const parts = merged.split("\n");
  const remainder = parts.pop() ?? "";
  const completeLines = parts.filter((line) => line.trim());
  const recentLines = [...previous.recentLines, ...completeLines].slice(-maxLines);

  return {
    offset: previous.offset + Buffer.byteLength(chunk),
    remainder,
    recentLines,
  };
}

export function detectApprovalPromptPhase(
  output: unknown,
  patterns = [
    "would you like to",
    "approve this",
    "approve the following",
    "confirm",
    "confirmation required",
  ],
  clearPatterns = [
    "reading files",
    "applying patch",
    "running tests",
    "running command",
    "edited",
    "changes applied",
  ],
): SessionPhase {
  if (!output || typeof output !== "string") return undefined;
  const recentLines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  if (recentLines.length === 0) return undefined;
  const recentMatchIndex = recentLines.findIndex((line) => {
    const normalized = line.toLowerCase();
    return patterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
  });
  if (recentMatchIndex === -1) return undefined;

  const hasClearSignalAfterPrompt = recentLines.slice(recentMatchIndex + 1).some((line) => {
    const normalized = line.toLowerCase();
    return clearPatterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
  });
  if (hasClearSignalAfterPrompt) return undefined;

  const hasApprovalChoices = recentLines.slice(recentMatchIndex + 1).some((line) => {
    const normalized = line.toLowerCase();
    return (
      normalized.includes("allow once") ||
      normalized.includes("allow for this session") ||
      normalized.includes("no, suggest changes") ||
      normalized.includes("press 1") ||
      normalized.includes("press 1-9") ||
      /^\W*1\./.test(normalized)
    );
  });

  if (hasApprovalChoices) return "permission";
  return recentMatchIndex >= recentLines.length - 3 ? "permission" : undefined;
}

export function updatePhaseHistory(
  previousPhase: SessionPhase,
  previousHistory: PhaseHistoryEntry[],
  nextPhase: SessionPhase,
  at: number,
  maxEntries = 5,
): { previousPhase?: SessionPhase; history: PhaseHistoryEntry[] } {
  if (!nextPhase || nextPhase === previousPhase) {
    return {
      previousPhase,
      history: previousHistory,
    };
  }

  return {
    previousPhase,
    history: [...previousHistory, { phase: nextPhase, at }].slice(-maxEntries),
  };
}

export function resolvePhaseFromHistory(
  currentPhase: SessionPhase,
  history: PhaseHistoryEntry[],
  nowMs = Date.now(),
  maxAgeMs = 10_000,
): SessionPhase {
  if (currentPhase) return currentPhase;
  const last = history.at(-1);
  if (!last) return undefined;
  if (nowMs - last.at > maxAgeMs) return undefined;
  return last.phase;
}

export function resolveSessionRegistryPath(
  registry: Map<string, SessionRegistryEntry>,
  sessionId: string,
): string | undefined {
  return registry.get(sessionId)?.filePath;
}

export function upsertSessionRegistryEntry(
  registry: Map<string, SessionRegistryEntry>,
  entry: SessionRegistryEntry,
): void {
  registry.set(entry.sessionId, entry);
}

export function selectRecentSessionFile(
  candidates: SessionFileCandidate[],
  nowMs = Date.now(),
  maxAgeMs = 72 * 60 * 60 * 1000,
  minLeadMs = 5 * 60 * 1000,
): string | undefined {
  if (candidates.length === 0) return undefined;

  const sorted = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = sorted[0];
  const second = sorted[1];

  if (nowMs - latest.mtimeMs > maxAgeMs) return undefined;
  if (second && latest.mtimeMs - second.mtimeMs < minLeadMs) return undefined;

  return latest.path;
}

function agentShortName(agentName: string): string {
  if (agentName === "Claude Code") return "Cl";
  if (agentName === "Codex") return "Cx";
  if (agentName === "Gemini") return "Gm";
  return agentName;
}

function attentionPriority(agent: AgentSession): number | undefined {
  if (agent.phase === "permission") return 0;
  if (agent.phase === "thinking") return 1;
  return undefined;
}

function attentionKind(agent: AgentSession): AttentionKind | undefined {
  if (agent.phase === "permission") return "permission";
  if (agent.phase === "thinking") return "thinking";
  if (agent.phase === "tool") return "tool";
  if (agent.status === "Dead" || agent.status === "Unmatched" || agent.status === "Stalled") {
    return undefined;
  }
  return "active";
}

function attentionActivityTime(
  agent: Pick<AgentSession, "lastActivityAt" | "lastResponseAt" | "startedAt">,
): number {
  return agent.lastActivityAt ?? agent.lastResponseAt ?? agent.startedAt ?? 0;
}

function orderedAttentionItems(items: AttentionItem[]): AttentionItem[] {
  const tier1Order: Partial<Record<AttentionKind, number>> = {
    permission: 0,
    thinking: 1,
  };

  return [...items].sort((a, b) => {
    const aTier1 = tier1Order[a.kind];
    const bTier1 = tier1Order[b.kind];

    if (aTier1 !== undefined || bTier1 !== undefined) {
      if (aTier1 === undefined) return 1;
      if (bTier1 === undefined) return -1;
      if (aTier1 !== bTier1) return aTier1 - bTier1;
      return attentionActivityTime(b) - attentionActivityTime(a);
    }

    return attentionActivityTime(b) - attentionActivityTime(a);
  });
}

/** Build prioritized attention list for popup/jump UX.
 * Order: permission -> thinking -> recently active alive sessions. */
export function buildAttentionItems(agents: AgentSession[]): AttentionItem[] {
  const alive = agents.filter(
    (agent) =>
      agent.status !== "Dead" && agent.status !== "Unmatched" && agent.status !== "Stalled",
  );

  const toAttentionItem = (
    agent: AgentSession,
    priority: number,
    kind: AttentionKind,
  ): AttentionItem => ({
    kind,
    priority,
    pid: agent.pid,
    agentName: agent.agentName,
    cwd: agent.cwd,
    cpuPercent: agent.cpuPercent,
    memoryMb: agent.memoryMb,
    startedAt: agent.startedAt,
    runtimeSource: agent.runtimeSource,
    status: agent.status,
    phase: agent.phase,
    lastResponseAt: agent.lastResponseAt,
    lastActivityAt: agent.lastActivityAt,
  });

  const tier1 = alive
    .filter((agent) => attentionPriority(agent) !== undefined)
    .sort((a, b) => {
      const aPriority = attentionPriority(a) ?? Number.MAX_SAFE_INTEGER;
      const bPriority = attentionPriority(b) ?? Number.MAX_SAFE_INTEGER;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return attentionActivityTime(b) - attentionActivityTime(a);
    })
    .map((agent) =>
      toAttentionItem(agent, attentionPriority(agent) ?? 0, attentionKind(agent) ?? "active"),
    );

  const tier1Pids = new Set(tier1.map((item) => item.pid));
  const tier2 = alive
    .filter((agent) => !tier1Pids.has(agent.pid))
    .sort((a, b) => attentionActivityTime(b) - attentionActivityTime(a))
    .map((agent) => toAttentionItem(agent, 2, attentionKind(agent) ?? "active"));

  return [...tier1, ...tier2];
}

export function selectAttentionItem(
  agents: AgentSession[],
  selection: number,
): AttentionItem | undefined {
  if (!Number.isInteger(selection) || selection < 1) return undefined;
  return buildAttentionItems(agents)[selection - 1];
}

/** Build jumpable attention items for interactive navigation.
 *  Statusline/jump share the same top-of-mind ordering. */
export function buildJumpAttentionItems(agents: AgentSession[]): AttentionItem[] {
  return orderedAttentionItems(buildAttentionItems(agents));
}

export function selectJumpAttentionItem(
  agents: AgentSession[],
  selection: number,
): AttentionItem | undefined {
  if (!Number.isInteger(selection) || selection < 1) return undefined;
  return buildJumpAttentionItems(agents)[selection - 1];
}

export function buildAttentionFocusText(
  items: AttentionItem[],
  maxCount = 3,
  width?: number,
): string | undefined {
  if (maxCount <= 0 || items.length === 0) return undefined;
  const layout = resolveStatuslineDetailLayout(width, maxCount);
  const detailItems = orderedAttentionItems(items)
    .filter((item) => item.kind !== "unmatched" && item.kind !== "stalled")
    .slice(0, layout.itemCount);

  const segments: string[] = [];
  for (const item of detailItems) {
    const agent = agentShortName(item.agentName);
    const path = compactStatuslineDirLabel(item.cwd, layout.pathMaxLength);
    const time = formatElapsedCompact(item.lastActivityAt ?? item.lastResponseAt);
    if (item.kind === "permission") {
      segments.push(`⏳${agent} ${path} allow`);
    } else if (item.kind === "stalled") {
      segments.push(time ? `⚠${agent} ${path} ${time}` : `⚠${agent} ${path}`);
    } else if (item.kind === "thinking") {
      segments.push(time ? `🤔${agent} ${path} ${time}` : `🤔${agent} ${path}`);
    } else if (item.kind === "tool") {
      segments.push(time ? `🔧${agent} ${path} ${time}` : `🔧${agent} ${path}`);
    } else if (item.kind === "active") {
      segments.push(time ? `•${agent} ${path} ${time}` : `•${agent} ${path}`);
    }
  }

  return segments.length > 0 ? segments.join(" │ ") : undefined;
}

export function buildTmuxBadgeSummary(snapshot: StatuslineSnapshot): string {
  const agentBadges = [];
  if ((snapshot.claudeCount ?? 0) > 0) agentBadges.push(`Cl ${snapshot.claudeCount}`);
  if ((snapshot.codexCount ?? 0) > 0) agentBadges.push(`Cx ${snapshot.codexCount}`);
  if ((snapshot.geminiCount ?? 0) > 0) agentBadges.push(`Gm ${snapshot.geminiCount}`);
  if (agentBadges.length === 0) agentBadges.push(`AI ${snapshot.aliveCount}`);

  const attentionBadges = [];
  if (snapshot.waitingCount > 0) attentionBadges.push(`⏳ ${snapshot.waitingCount}`);
  if (snapshot.stalledCount + snapshot.unmatchedCount + snapshot.riskCount > 0) {
    attentionBadges.push(
      `⚠ ${snapshot.stalledCount + snapshot.unmatchedCount + snapshot.riskCount}`,
    );
  }
  if ((snapshot.thinkingCount ?? 0) > 0) attentionBadges.push(`🤔 ${snapshot.thinkingCount}`);
  if ((snapshot.toolCount ?? 0) > 0) attentionBadges.push(`🔧 ${snapshot.toolCount}`);

  if (attentionBadges.length === 0) {
    attentionBadges.push(`✅ ${snapshot.activeCount}`);
  }

  return `${agentBadges.join("  ")}   ${attentionBadges.join("  ")}`;
}

export function buildStatusPills(snapshot: StatuslineSnapshot): {
  agents: StatusPill[];
  alerts: StatusPill[];
} {
  const agents: StatusPill[] = [];
  if ((snapshot.claudeCount ?? 0) > 0) {
    agents.push({ label: `Cl ${snapshot.claudeCount}`, fg: "#1e1e2e", bg: "#fab387" });
  }
  if ((snapshot.codexCount ?? 0) > 0) {
    agents.push({ label: `Cx ${snapshot.codexCount}`, fg: "#1e1e2e", bg: "#94e2d5" });
  }
  if ((snapshot.geminiCount ?? 0) > 0) {
    agents.push({ label: `Gm ${snapshot.geminiCount}`, fg: "#1e1e2e", bg: "#89b4fa" });
  }
  if (agents.length === 0) {
    agents.push({ label: `AI ${snapshot.aliveCount}`, fg: "#1e1e2e", bg: "#cba6f7" });
  }

  const alerts: StatusPill[] = [];
  if (snapshot.waitingCount > 0) {
    alerts.push({ label: `⏳ ${snapshot.waitingCount}`, fg: "#11111b", bg: "#f38ba8" });
  }
  if (snapshot.stalledCount + snapshot.unmatchedCount + snapshot.riskCount > 0) {
    alerts.push({
      label: `⚠ ${snapshot.stalledCount + snapshot.unmatchedCount + snapshot.riskCount}`,
      fg: "#11111b",
      bg: "#f9e2af",
    });
  }
  if ((snapshot.thinkingCount ?? 0) > 0) {
    alerts.push({ label: `🤔 ${snapshot.thinkingCount}`, fg: "#11111b", bg: "#cba6f7" });
  }
  if ((snapshot.toolCount ?? 0) > 0) {
    alerts.push({ label: `🔧 ${snapshot.toolCount}`, fg: "#11111b", bg: "#a6e3a1" });
  }
  if (alerts.length === 0) {
    alerts.push({ label: `✅ ${snapshot.activeCount}`, fg: "#11111b", bg: "#a6e3a1" });
  }

  return { agents, alerts };
}

/** Build one-line persistent-bar summary string. */
export function buildStatuslineSummary(
  snapshot: StatuslineSnapshot,
  format: StatuslineFormat = "compact",
): string {
  if (format === "tmux-badges" || format === "wezterm-pills") {
    return buildTmuxBadgeSummary(snapshot);
  }

  const compactParts = [`AI${snapshot.aliveCount}`];
  const standardParts = [`AI ${snapshot.aliveCount}`];

  if (snapshot.waitingCount > 0) {
    compactParts.push(`!${snapshot.waitingCount}`);
    standardParts.push(`wait ${snapshot.waitingCount}`);
  }
  if (snapshot.riskCount > 0) {
    compactParts.push(`R${snapshot.riskCount}`);
    standardParts.push(`risk ${snapshot.riskCount}`);
  }
  if (snapshot.stalledCount > 0) {
    compactParts.push(`S${snapshot.stalledCount}`);
    standardParts.push(`stalled ${snapshot.stalledCount}`);
  }
  if (snapshot.unmatchedCount > 0) {
    compactParts.push(`O${snapshot.unmatchedCount}`);
    standardParts.push(`orphan ${snapshot.unmatchedCount}`);
  }

  if (format === "extended") {
    if (snapshot.activeCount > 0) standardParts.push(`active ${snapshot.activeCount}`);
    if (snapshot.highCpuCount > 0) standardParts.push(`hot ${snapshot.highCpuCount}`);
  }

  if (
    snapshot.waitingCount === 0 &&
    snapshot.riskCount === 0 &&
    snapshot.stalledCount === 0 &&
    snapshot.unmatchedCount === 0
  ) {
    compactParts.push("ok");
    standardParts.push("ok");
  }

  if (format === "compact") {
    const metrics = [];
    if (snapshot.cpuPercent !== undefined) metrics.push(`${snapshot.cpuPercent.toFixed(0)}%`);
    if (snapshot.memoryUsedGb !== undefined) metrics.push(`${snapshot.memoryUsedGb}G`);
    return metrics.length > 0
      ? `${compactParts.join(" ")} | ${metrics.join(" ")}`
      : compactParts.join(" ");
  }

  const metrics = [];
  if (snapshot.cpuPercent !== undefined) metrics.push(`CPU ${snapshot.cpuPercent.toFixed(0)}%`);
  if (format === "extended" && snapshot.memoryUsedGb !== undefined) {
    metrics.push(`MEM ${snapshot.memoryUsedGb}G`);
  }
  if (metrics.length > 0) standardParts.push(...metrics);

  return standardParts.join(" | ");
}

export type BadgeStyle = "basic" | "basic-mono" | "text" | "text-mono";

function attentionBg(kind: Exclude<AttentionKind, "unmatched">): string {
  if (kind === "permission") return "#f38ba8";
  if (kind === "thinking") return "#cba6f7";
  if (kind === "tool") return "#a6e3a1";
  if (kind === "active") return "#6ee7b7";
  return "#f9e2af";
}

function tmuxAttentionSegment(
  index: number,
  kind: Exclude<AttentionKind, "unmatched">,
  label: string,
): string {
  const bg = attentionBg(kind);
  return `#[fg=${bg},bg=#1e1e2e]#[bold,fg=#11111b,bg=${bg}] ${index} #[fg=#313244,bg=${bg}]#[fg=#cdd6f4,bg=#313244] ${label} #[fg=#313244,bg=#1e1e2e]#[default]`;
}

export function buildTmuxBadgeBar(
  snapshot: StatuslineSnapshot,
  focusText?: string,
  badgeStyle: BadgeStyle = "basic",
): string {
  const theme = resolveTheme(badgeStyle);
  const { agents, alerts } = buildStatusPills(snapshot);
  const agentPills = agents.map((pill) => renderBadge(theme, pill.label, pill.fg, pill.bg));
  const alertPills = alerts.map((pill) => renderBadge(theme, pill.label, pill.fg, pill.bg));
  const focus = focusText ? renderFocus(theme, focusText) : "";
  return [agentPills.join(" "), alertPills.join(" "), focus].filter(Boolean).join("  ");
}

export function buildTmuxAttentionPills(
  items: AttentionItem[],
  maxCount = 5,
  width?: number,
  badgeStyle: BadgeStyle = "basic",
): string | undefined {
  if (maxCount <= 0) return undefined;
  const layout = resolveStatuslineDetailLayout(width, maxCount);
  const jumpItems = orderedAttentionItems(items)
    .filter(
      (item): item is AttentionItem & { kind: Exclude<AttentionKind, "unmatched"> } =>
        item.kind !== "unmatched" && item.kind !== "stalled",
    )
    .slice(0, layout.itemCount);

  const theme = resolveTheme(badgeStyle);

  if (jumpItems.length === 0) {
    return theme.empty;
  }

  const segments = jumpItems.map((item, index) => {
    const agent = agentShortName(item.agentName);
    const path = compactStatuslineDirLabel(item.cwd, layout.pathMaxLength);
    const time = formatElapsedCompact(item.lastActivityAt ?? item.lastResponseAt);
    const label =
      item.kind === "permission"
        ? `⏳${agent} ${path} allow`
        : item.kind === "thinking"
          ? time
            ? `🤔${agent} ${path} ${time}`
            : `🤔${agent} ${path}`
          : item.kind === "tool"
            ? time
              ? `🔧${agent} ${path} ${time}`
              : `🔧${agent} ${path}`
            : item.kind === "active"
              ? time
                ? `•${agent} ${path} ${time}`
                : `•${agent} ${path}`
              : time
                ? `⚠${agent} ${path} ${time}`
                : `⚠${agent} ${path}`;
    return renderAttention(theme, index + 1, label, attentionBg(item.kind));
  });

  return segments.join("  ");
}

export function serializeWeztermPills(snapshot: StatuslineSnapshot, focusText?: string): string {
  const { agents, alerts } = buildStatusPills(snapshot);
  const lines = [
    ...agents.map((pill) => `agent\t${pill.label}\t${pill.fg}\t${pill.bg}`),
    ...alerts.map((pill) => `alert\t${pill.label}\t${pill.fg}\t${pill.bg}`),
  ];
  if (focusText) {
    for (const segment of focusText.split(" │ ")) {
      const trimmed = segment.trim();
      if (trimmed !== "") {
        lines.push(`focus\t${trimmed}\t#bac2de\t#181825`);
      }
    }
  }
  return lines.join("\n");
}

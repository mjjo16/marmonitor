import chalk from "chalk";
import * as si from "systeminformation";
import type { TmuxJumpResult } from "../tmux/index.js";
import type {
  AgentSession,
  SessionPhase,
  SystemInfo,
  TokenUsage,
  WorkerProcess,
} from "../types.js";
import {
  type BadgeStyle,
  type StatuslineFormat,
  buildAttentionFocusText,
  buildAttentionItems,
  buildJumpAttentionItems,
  buildStatuslineSummary,
  buildTmuxAttentionPills,
  buildTmuxBadgeBar,
  compactDirLabel,
  formatElapsed,
  formatTokens,
  serializeWeztermPills,
  shortenPath,
} from "./utils.js";

/** Collect system resource info */
export async function getSystemInfo(): Promise<SystemInfo> {
  const [cpu, mem, battery] = await Promise.all([si.currentLoad(), si.mem(), si.battery()]);

  const info: SystemInfo = {
    cpuPercent: Math.round(cpu.currentLoad * 10) / 10,
    memoryUsedGb: Math.round((mem.used / 1024 ** 3) * 10) / 10,
    memoryTotalGb: Math.round(mem.total / 1024 ** 3),
  };

  if (battery.hasBattery) {
    info.batteryPercent = battery.percent;
    info.batteryCharging = battery.isCharging;
  }

  return info;
}

// shortenPath, formatElapsed, formatTokens imported from ./utils.js

let monoMode = false;

/** Apply badge style to terminal chalk output: mono uses bold/dim only */
export function applyTerminalStyle(badgeStyle: BadgeStyle): void {
  monoMode = badgeStyle === "basic-mono" || badgeStyle === "text-mono";
}

/** Agent name with distinct color */
function agentLabel(name: string): string {
  const label = name === "Claude Code" ? "Claude" : name;
  if (monoMode) return chalk.bold.white(label);
  switch (name) {
    case "Claude Code":
      return chalk.hex("#D97706")("Claude"); // amber/orange
    case "Codex":
      return chalk.hex("#10B981")("Codex"); // emerald/green
    case "Gemini":
      return chalk.hex("#3B82F6")("Gemini"); // blue
    default:
      return chalk.white(name);
  }
}

/** Status icon/color */
function statusLabel(status: AgentSession["status"]): string {
  if (monoMode) {
    switch (status) {
      case "Active":
        return chalk.white("[Active]   ");
      case "Idle":
        return chalk.gray("[Idle]     ");
      case "Stalled":
        return chalk.dim("[Stalled]  ");
      case "Unmatched":
        return chalk.dim("[Unmatched]");
      case "Dead":
        return chalk.dim("[Dead]     ");
    }
  }
  switch (status) {
    case "Active":
      return chalk.green("[Active]   ");
    case "Idle":
      return chalk.yellow("[Idle]     ");
    case "Stalled":
      return chalk.red("[Stalled]  ");
    case "Unmatched":
      return chalk.magenta("[Unmatched]");
    case "Dead":
      return chalk.gray("[Dead]     ");
  }
}

function displayStatusLabel(status: AgentSession["status"], phase?: SessionPhase): string {
  if (monoMode) {
    if (phase === "permission") return chalk.bold.white("[Allow]   ");
    if (phase === "tool") return chalk.white("[Tool]    ");
    if (phase === "thinking") return chalk.white("[Think]   ");
    return statusLabel(status);
  }
  if (phase === "permission") return chalk.red("[Allow]   ");
  if (phase === "tool") return chalk.green("[Tool]    ");
  if (phase === "thinking") return chalk.magenta("[Think]   ");
  return statusLabel(status);
}

/** Phase emoji */
function phaseIcon(phase?: SessionPhase): string {
  switch (phase) {
    case "thinking":
      return " 🤔";
    case "tool":
      return " 🔧";
    case "permission":
      return " ⏳";
    case "done":
      return " ✅";
    default:
      return "";
  }
}

function runtimeLabel(source?: AgentSession["runtimeSource"]): string {
  switch (source) {
    case "cli":
      return chalk.dim(" [cli]");
    case "vscode":
      return chalk.dim(" [vscode]");
    default:
      return "";
  }
}

/** Format token usage as a compact string */
function formatTokenUsage(t?: TokenUsage, model?: string): string {
  if (!t) return "";
  const parts = [`in:${formatTokens(t.inputTokens)}`, `out:${formatTokens(t.outputTokens)}`];
  if (t.cacheReadTokens > 0) parts.push(`cache:${formatTokens(t.cacheReadTokens)}`);
  const modelStr = model ? chalk.dim(` [${model}]`) : "";
  return chalk.cyan(`  tokens(${parts.join(" ")})`) + modelStr;
}

/** Print system info line */
function printSystemLine(sys: SystemInfo): void {
  let line = `System: CPU ${sys.cpuPercent}% | MEM ${sys.memoryUsedGb}/${sys.memoryTotalGb}GB`;
  if (sys.batteryPercent !== undefined) {
    const plug = sys.batteryCharging ? "+" : "";
    line += ` | Battery ${sys.batteryPercent}%${plug}`;
  }
  console.log(line);
}

/** Print agent status as formatted text */
export async function printStatus(agents: AgentSession[]): Promise<void> {
  const sys = await getSystemInfo();
  printSystemLine(sys);
  console.log();

  const alive = agents.filter((a) => a.status !== "Dead" && a.status !== "Unmatched");
  const unmatched = agents.filter((a) => a.status === "Unmatched");
  const dead = agents.filter((a) => a.status === "Dead");

  if (alive.length === 0 && unmatched.length === 0 && dead.length === 0) {
    console.log("No AI agent sessions detected.");
    return;
  }

  if (alive.length > 0) {
    console.log(`AI Sessions (${alive.length} active):`);
    for (const a of alive) {
      const icon = displayStatusLabel(a.status, a.phase);
      const path = shortenPath(a.cwd);
      const started = formatElapsed(a.startedAt);
      const tokens = formatTokenUsage(a.tokenUsage, a.model);
      const agent = agentLabel(a.agentName).padEnd(18);
      const phase = phaseIcon(a.phase);
      const runtime = runtimeLabel(a.runtimeSource);
      const lastTime = a.lastResponseAt
        ? chalk.dim(`  last response ${formatElapsed(a.lastResponseAt)}`)
        : a.lastActivityAt
          ? chalk.dim(`  last activity ${formatElapsed(a.lastActivityAt)}`)
          : "";
      console.log(`  ${icon}  ${agent} PID:${String(a.pid).padEnd(6)} ${path}${runtime}${phase}`);
      console.log(
        `           CPU:${a.cpuPercent}%  MEM:${a.memoryMb.toFixed(0)}MB  started ${started}${lastTime}${tokens}`,
      );

      if (a.workers && a.workers.length > 0) {
        for (let i = 0; i < a.workers.length; i++) {
          const w = a.workers[i];
          const isLast = i === a.workers.length - 1;
          const branch = isLast ? "└──" : "├──";
          const wStatus = statusLabel(w.status).trim();
          console.log(
            chalk.dim(
              `           ${branch} PID:${String(w.pid).padEnd(6)} CPU:${w.cpuPercent}%  MEM:${w.memoryMb.toFixed(0)}MB  ${wStatus}`,
            ),
          );
        }
      }
    }
  }

  if (unmatched.length > 0) {
    console.log(
      chalk.magenta(
        `\nUnmatched Processes (${unmatched.length}) — no matching session, consider killing:`,
      ),
    );
    for (const a of unmatched) {
      const agent = agentLabel(a.agentName);
      console.log(
        `  ${chalk.magenta("[Unmatched]")}  ${agent}  PID:${a.pid}  MEM:${a.memoryMb.toFixed(0)}MB${runtimeLabel(a.runtimeSource)}  ${chalk.dim(`kill ${a.pid}`)}`,
      );
    }
  }

  if (dead.length > 0) {
    console.log(`\nDead Sessions (${dead.length}):`);
    for (const a of dead) {
      const path = shortenPath(a.cwd);
      const started = formatElapsed(a.startedAt);
      const tokens = formatTokenUsage(a.tokenUsage, a.model);
      const agent = agentLabel(a.agentName);
      console.log(
        `  ${chalk.gray("[Dead]")}    ${agent}  PID:${String(a.pid).padEnd(6)} ${path}  started ${started}${tokens}`,
      );
    }
  }
}

/** Print agent status as JSON */
export async function printStatusJson(agents: AgentSession[]): Promise<void> {
  const sys = await getSystemInfo();
  console.log(JSON.stringify({ system: sys, agents }, null, 2));
}

export function printCleanPlan(agents: AgentSession[], kill: boolean): void {
  if (agents.length === 0) {
    console.log("No unmatched processes to clean.");
    return;
  }

  console.log(
    kill
      ? `Cleaning ${agents.length} unmatched process(es) with SIGTERM:`
      : `Cleanup candidates (${agents.length}) — rerun with --kill to terminate:`,
  );

  for (const agent of agents) {
    const label = agentLabel(agent.agentName);
    console.log(
      `  ${label} PID:${agent.pid}  MEM:${agent.memoryMb.toFixed(0)}MB${runtimeLabel(agent.runtimeSource)}  ${shortenPath(agent.cwd)}`,
    );
  }
}

export function printCleanJson(
  agents: AgentSession[],
  executed: boolean,
  signal = "SIGTERM",
): void {
  console.log(
    JSON.stringify(
      {
        executed,
        signal,
        count: agents.length,
        targets: agents.map((agent) => ({
          agentName: agent.agentName,
          pid: agent.pid,
          cwd: agent.cwd,
          runtimeSource: agent.runtimeSource,
          memoryMb: agent.memoryMb,
        })),
      },
      null,
      2,
    ),
  );
}

function attentionKindLabel(kind: ReturnType<typeof buildAttentionItems>[number]["kind"]): string {
  switch (kind) {
    case "unmatched":
      return "⚠ Orphan";
    case "permission":
      return "⏳ Allow Waiting";
    case "stalled":
      return "⚠ Stalled";
    case "thinking":
      return "🤔 Thinking";
    case "tool":
      return "🔧 Tool";
    case "active":
      return "• Recent";
  }
}

function attentionLine(item: ReturnType<typeof buildAttentionItems>[number]): string {
  const name = item.agentName === "Claude Code" ? "Claude" : item.agentName;
  const path = compactDirLabel(item.cwd);
  const runtime = runtimeLabel(item.runtimeSource);
  const time = item.lastResponseAt
    ? `  ${chalk.dim(formatElapsed(item.lastResponseAt))}`
    : item.lastActivityAt
      ? `  ${chalk.dim(formatElapsed(item.lastActivityAt))}`
      : "";

  if (item.kind === "unmatched") {
    return `${name}  ${chalk.dim(path)}${runtime}  PID:${item.pid}${time}`;
  }
  if (item.kind === "permission") {
    return `${name}  ${chalk.dim(path)}${runtime}  allow pending  PID:${item.pid}${time}`;
  }
  if (item.kind === "stalled") {
    return `${name}  ${chalk.dim(path)}${runtime}  stalled  PID:${item.pid}${time}`;
  }
  if (item.kind === "thinking") {
    return `${name}  ${chalk.dim(path)}${runtime}  thinking  PID:${item.pid}${time}`;
  }
  if (item.kind === "active") {
    return `${name}  ${chalk.dim(path)}${runtime}  recent  PID:${item.pid}${time}`;
  }
  return `${name}  ${chalk.dim(path)}${runtime}  tool  PID:${item.pid}${time}`;
}

function jumpAttentionStatusLabel(
  item: ReturnType<typeof buildJumpAttentionItems>[number],
): string {
  if (item.kind === "permission") return chalk.red("[Allow]   ");
  if (item.kind === "thinking") return chalk.green("[Thinking]");
  if (item.kind === "tool") return chalk.cyan("[Tool]    ");
  return chalk.blue("[Recent]  ");
}

function jumpAttentionPhaseIcon(item: ReturnType<typeof buildJumpAttentionItems>[number]): string {
  if (item.kind === "permission") return " ⏳";
  if (item.kind === "thinking") return " 🤔";
  if (item.kind === "tool") return " 🔧";
  return " •";
}

function jumpAttentionLine(item: ReturnType<typeof buildJumpAttentionItems>[number]): string {
  const name = item.agentName === "Claude Code" ? "Claude" : item.agentName;
  const path = compactDirLabel(item.cwd);
  const runtime = runtimeLabel(item.runtimeSource);
  const started = item.startedAt ? chalk.dim(` started ${formatElapsed(item.startedAt)}`) : "";
  const activity = item.lastResponseAt
    ? chalk.dim(`  last response ${formatElapsed(item.lastResponseAt)}`)
    : item.lastActivityAt
      ? chalk.dim(`  last activity ${formatElapsed(item.lastActivityAt)}`)
      : "";
  const stats = `CPU:${item.cpuPercent ?? 0}% MEM:${item.memoryMb?.toFixed(0) ?? "0"}MB`;
  const status = jumpAttentionStatusLabel(item);
  const icon = jumpAttentionPhaseIcon(item);
  const agent = agentLabel(item.agentName).padEnd(8);

  if (item.kind === "permission") {
    return `  ${status} ${agent} ${chalk.dim(path)}${runtime}${icon}\n             PID:${item.pid}  ${stats}${started}${activity}`;
  }
  if (item.kind === "thinking") {
    return `  ${status} ${agent} ${chalk.dim(path)}${runtime}${icon}\n             PID:${item.pid}  ${stats}${started}${activity}`;
  }
  if (item.kind === "tool") {
    return `  ${status} ${agent} ${chalk.dim(path)}${runtime}${icon}\n             PID:${item.pid}  ${stats}${started}${activity}`;
  }
  return `  ${status} ${agent} ${chalk.dim(path)}${runtime}${icon}\n             PID:${item.pid}  ${stats}${started}${activity}`;
}

function paginateJumpAttentionItems<T>(items: T[], page: number, pageSize = 10): T[] {
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const normalizedSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 10;
  const start = (normalizedPage - 1) * normalizedSize;
  return items.slice(start, start + normalizedSize);
}

export function renderJumpAttentionChooser(
  agents: AgentSession[],
  page = 1,
  pageSize = 10,
): string {
  const items = buildJumpAttentionItems(agents);
  if (items.length === 0) {
    return "No jumpable attention items.";
  }

  const shown = paginateJumpAttentionItems(items, page, pageSize);
  if (shown.length === 0) {
    return "No jumpable attention items.";
  }

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const lines = [
    `Select session to jump to (${items.length}) — ${totalPages > 1 ? `< ${page}/${totalPages} >` : "< 1/1 >"}:`,
  ];

  shown.forEach((item, index) => {
    const [firstLine, ...restLines] = jumpAttentionLine(item).split("\n");
    const displayNumber = index + 1;
    const indexLabel = `${displayNumber})`.padStart(displayNumber === 10 ? 4 : 3);
    lines.push(`${indexLabel} ${firstLine.trimStart()}`);
    for (const line of restLines) {
      lines.push(`    ${line.trimStart()}`);
    }
    if (index < shown.length - 1) {
      lines.push(chalk.dim("    ───────────────────────────────────────────────────────────"));
    }
  });

  return lines.join("\n");
}

export function printAttention(agents: AgentSession[], limit = 12): void {
  const items = buildAttentionItems(agents);
  if (items.length === 0) {
    console.log("No attention items.");
    return;
  }

  const shown = items.slice(0, limit);
  const groups = new Map<string, typeof shown>();
  for (const item of shown) {
    const existing = groups.get(item.kind) ?? [];
    existing.push(item);
    groups.set(item.kind, existing);
  }

  console.log(`Attention (${items.length}):`);
  for (const [kind, grouped] of groups.entries()) {
    console.log(
      `\n${attentionKindLabel(kind as (typeof shown)[number]["kind"])} (${grouped.length}):`,
    );
    grouped.forEach((item, index) => {
      console.log(`  ${index + 1}) ${attentionLine(item)}`);
    });
  }

  if (shown.length < items.length) {
    console.log(`\n${chalk.dim(`+${items.length - shown.length} more`)}`);
  }
}

export function printAttentionJson(agents: AgentSession[], limit = 12): void {
  const items = buildAttentionItems(agents).slice(0, limit);
  console.log(JSON.stringify({ count: items.length, items }, null, 2));
}

export function printAttentionChooser(agents: AgentSession[], limit = 12): void {
  const items = buildAttentionItems(agents).slice(0, limit);
  if (items.length === 0) {
    console.log("No attention items.");
    return;
  }

  console.log("Select attention item:");
  items.forEach((item, index) => {
    console.log(`  ${index + 1}) ${attentionLine(item)}`);
  });
}

export function printJumpAttentionChooser(agents: AgentSession[], limit = 10): void {
  console.log(renderJumpAttentionChooser(agents, 1, limit));
}

export function printJumpResult(result: TmuxJumpResult): void {
  if (!result.found) {
    console.log(chalk.yellow(result.message ?? "No matching tmux pane found."));
    return;
  }
  if (!result.executed) {
    console.log(chalk.yellow(result.message ?? "Matched tmux pane but switch failed."));
    return;
  }

  const target = result.target ? chalk.bold(result.target) : chalk.bold("unknown");
  const match = result.match ? chalk.dim(`(${result.match})`) : "";
  console.log(`Jumped to ${target} ${match}`.trim());
}

export function printJumpJson(result: TmuxJumpResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Print compact dock view for tmux side/bottom pane.
 * Prioritizes attention signals over completeness.
 */
export async function printDock(agents: AgentSession[], maxLines = 12): Promise<void> {
  const sys = await getSystemInfo();
  const alive = agents.filter((a) => a.status !== "Dead" && a.status !== "Unmatched");
  const unmatched = agents.filter((a) => a.status === "Unmatched");
  const waitingCount = alive.filter((a) => a.phase === "permission").length;
  const stalledCount = alive.filter((a) => a.status === "Stalled").length;

  const alerts: string[] = [];
  if (waitingCount > 0) alerts.push(chalk.red(`!${waitingCount} waiting`));
  if (stalledCount > 0) alerts.push(chalk.yellow(`${stalledCount} stalled`));
  if (unmatched.length > 0) alerts.push(chalk.magenta(`${unmatched.length} orphan`));
  const alertStr = alerts.length > 0 ? `  ${alerts.join(" ")}` : "";

  console.log(
    `${chalk.bold("AI")} ${alive.length}/${agents.length}  CPU:${sys.cpuPercent.toFixed(0)}% MEM:${sys.memoryUsedGb}G${alertStr}`,
  );
  console.log(chalk.dim("─".repeat(36)));

  const prioritized = [...alive].sort((a, b) => {
    const pri = (agent: AgentSession): number => {
      if (agent.phase === "permission") return 0;
      if (agent.status === "Stalled") return 1;
      if (agent.status === "Active") return 2;
      return 3;
    };
    return pri(a) - pri(b);
  });

  const unmatchedLine = unmatched.length > 0 ? 1 : 0;
  const slots = Math.max(maxLines - 2 - unmatchedLine, 0);
  const shown = prioritized.slice(0, slots);

  for (const agent of shown) {
    const coloredAgent = agentLabel(agent.agentName);
    const phase = phaseIcon(agent.phase);
    const lastDir = compactDirLabel(agent.cwd);
    const time = agent.lastResponseAt
      ? formatElapsed(agent.lastResponseAt)
      : agent.lastActivityAt
        ? formatElapsed(agent.lastActivityAt)
        : "";
    const timeStr = time ? chalk.dim(` ${time}`) : "";
    console.log(`${coloredAgent} ${chalk.dim(lastDir)}${phase}${timeStr}`);
  }

  if (shown.length < prioritized.length) {
    console.log(chalk.dim(`  +${prioritized.length - shown.length} more`));
  }

  if (unmatched.length > 0) {
    console.log(chalk.magenta(`! ${unmatched.length} unmatched (marmonitor clean)`));
  }
}

/** Print one-line summary for tmux/terminal status bar */
export function renderUnavailableStatusline(format: StatuslineFormat = "compact"): string {
  if (format === "wezterm-pills") {
    return "focus\tmarmonitor unavailable\t#bac2de\t#313244";
  }
  return "marmonitor unavailable";
}

/** Print one-line summary for tmux/terminal status bar */
export async function renderStatusline(
  agents: AgentSession[],
  format: StatuslineFormat = "compact",
  attentionLimit = 5,
  width?: number,
  badgeStyle: BadgeStyle = "basic",
  hasJumpAnchor = false,
): Promise<string> {
  const alive = agents.filter((a) => a.status !== "Dead" && a.status !== "Unmatched");
  const unmatched = agents.filter((a) => a.status === "Unmatched");

  if (alive.length === 0) {
    return format === "wezterm-pills" ? renderUnavailableStatusline(format) : "AI:0";
  }

  const sys = await getSystemInfo();
  const waitingCount = alive.filter((a) => a.phase === "permission").length;
  const stalledCount = alive.filter((a) => a.status === "Stalled").length;
  const activeCount = alive.filter((a) => a.status === "Active").length;
  const highCpuCount = alive.filter((a) => a.cpuPercent >= 10).length;
  const thinkingCount = alive.filter((a) => a.phase === "thinking").length;
  const toolCount = alive.filter((a) => a.phase === "tool").length;
  const claudeCount = alive.filter((a) => a.agentName === "Claude Code").length;
  const codexCount = alive.filter((a) => a.agentName === "Codex").length;
  const geminiCount = alive.filter((a) => a.agentName === "Gemini").length;
  const snapshot = {
    aliveCount: alive.length,
    waitingCount,
    riskCount: 0,
    stalledCount,
    unmatchedCount: unmatched.length,
    activeCount,
    highCpuCount,
    thinkingCount,
    toolCount,
    claudeCount,
    codexCount,
    geminiCount,
    cpuPercent: sys.cpuPercent,
    memoryUsedGb: sys.memoryUsedGb,
  };

  if (format === "tmux-badges") {
    const focusText = buildTmuxAttentionPills(
      buildJumpAttentionItems(agents),
      attentionLimit,
      width,
      badgeStyle,
    );
    return buildTmuxBadgeBar(snapshot, focusText, badgeStyle, hasJumpAnchor);
  }

  if (format === "wezterm-pills") {
    const focusText = buildAttentionFocusText(buildAttentionItems(agents), attentionLimit, width);
    return serializeWeztermPills(snapshot, focusText);
  }

  return buildStatuslineSummary(snapshot, format);
}

/** Print one-line summary for tmux/terminal status bar */
export async function printStatusline(
  agents: AgentSession[],
  format: StatuslineFormat = "compact",
  attentionLimit = 5,
  width?: number,
): Promise<void> {
  console.log(await renderStatusline(agents, format, attentionLimit, width));
}

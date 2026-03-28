import { readFile } from "node:fs/promises";
import type { MarmonitorConfig } from "../config/index.js";

export type GuardAction = "ignore" | "alert" | "hold" | "block";
export type GuardTrigger =
  | "dangerous_command"
  | "prod_path_access"
  | "secret_access"
  | "out_of_cwd_write";

export interface HookEvent {
  agent: "claude";
  toolName?: string;
  cwd?: string;
  command?: string;
  filePath?: string;
  raw: unknown;
}

export interface GuardDecision {
  decision: "allow" | "block";
  message?: string;
  matchedRuleId?: string;
  trigger?: GuardTrigger;
  action?: GuardAction;
}

const DANGEROUS_COMMAND_PATTERNS = [/\brm\s+-rf\s+\//, /\bmkfs\b/, /\bdd\s+if=.*\sof=\/dev\//];

const SECRET_PATH_PATTERNS = [/\.env\b/, /\/secrets?\b/, /\/\.ssh\b/, /id_rsa\b/];
const PROD_PATH_PATTERNS = [/\/prod\b/, /\/production\b/, /prod/i];

function normalizeAction(action: GuardAction): "allow" | "block" {
  if (action === "block") return "block";
  return "allow";
}

export function parseHookEvent(input: string): HookEvent | undefined {
  try {
    const raw = JSON.parse(input) as Record<string, unknown>;
    const toolName =
      typeof raw.tool_name === "string"
        ? raw.tool_name
        : typeof raw.toolName === "string"
          ? raw.toolName
          : undefined;
    const toolInput =
      raw.tool_input && typeof raw.tool_input === "object"
        ? (raw.tool_input as Record<string, unknown>)
        : raw.toolInput && typeof raw.toolInput === "object"
          ? (raw.toolInput as Record<string, unknown>)
          : undefined;

    return {
      agent: "claude",
      toolName,
      cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      command: typeof toolInput?.command === "string" ? toolInput.command : undefined,
      filePath:
        typeof toolInput?.file_path === "string"
          ? toolInput.file_path
          : typeof toolInput?.path === "string"
            ? toolInput.path
            : undefined,
      raw,
    };
  } catch {
    return undefined;
  }
}

export function detectGuardTriggers(event: HookEvent): GuardTrigger[] {
  const triggers = new Set<GuardTrigger>();
  const command = event.command ?? "";
  const filePath = event.filePath ?? "";
  const cwd = event.cwd ?? "";

  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    triggers.add("dangerous_command");
  }
  if (PROD_PATH_PATTERNS.some((pattern) => pattern.test(command) || pattern.test(filePath))) {
    triggers.add("prod_path_access");
  }
  if (SECRET_PATH_PATTERNS.some((pattern) => pattern.test(command) || pattern.test(filePath))) {
    triggers.add("secret_access");
  }
  if (filePath && cwd && !filePath.startsWith(cwd)) {
    triggers.add("out_of_cwd_write");
  }

  return [...triggers];
}

function ruleMatches(
  rule: MarmonitorConfig["intervention"]["rules"][number],
  event: HookEvent,
  trigger: GuardTrigger,
): boolean {
  if (!rule.enabled) return false;
  if (rule.trigger !== trigger) return false;
  if (rule.agents && !rule.agents.includes(event.agent)) return false;

  if (rule.match?.toolNames && event.toolName && !rule.match.toolNames.includes(event.toolName)) {
    return false;
  }
  if (rule.match?.cwdPrefix && event.cwd && !event.cwd.startsWith(rule.match.cwdPrefix)) {
    return false;
  }
  if (rule.match?.commandRegex) {
    const command = event.command ?? "";
    try {
      if (!new RegExp(rule.match.commandRegex).test(command)) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export function evaluateGuard(config: MarmonitorConfig, event: HookEvent): GuardDecision {
  if (!config.intervention.enabled) {
    return { decision: "allow" };
  }

  const triggers = detectGuardTriggers(event);
  if (triggers.length === 0) {
    return { decision: "allow" };
  }

  for (const trigger of triggers) {
    const matchedRule = config.intervention.rules.find((rule) => ruleMatches(rule, event, trigger));
    if (!matchedRule) continue;

    const action = matchedRule.action ?? config.intervention.defaultAction;
    const decision = normalizeAction(action);
    return {
      decision,
      matchedRuleId: matchedRule.id,
      trigger,
      action,
      message:
        decision === "block"
          ? `Blocked by marmonitor: ${trigger}${matchedRule.id ? ` (${matchedRule.id})` : ""}`
          : undefined,
    };
  }

  const action = config.intervention.defaultAction;
  const decision = normalizeAction(action);
  return {
    decision,
    trigger: triggers[0],
    action,
    message: decision === "block" ? `Blocked by marmonitor: ${triggers[0]}` : undefined,
  };
}

export async function readStdin(): Promise<string> {
  return readFile("/dev/stdin", "utf8");
}

export function formatGuardOutput(result: GuardDecision): string {
  if (result.decision === "block") {
    return JSON.stringify({
      decision: "block",
      message: result.message ?? "Blocked by marmonitor",
    });
  }

  return JSON.stringify({ decision: "allow" });
}

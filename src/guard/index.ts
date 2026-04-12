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

const DANGEROUS_COMMAND_PATTERNS = [
  // 루트/홈/전체 강제 삭제
  /\brm\s+(-\w*f\w*\s+.*-\w*r\w*|-\w*r\w*\s+.*-\w*f\w*)\s+(\/|~|\/\*|\.\.)/, // rm -rf / ~ /* ..
  /\brm\s+-rf\s+/, // rm -rf (anything — broad catch)
  /\bmkfs\b/, // 파일시스템 포맷
  // sudo + 파괴적 명령
  /\bsudo\s+rm\b/,
  /\bsudo\s+chmod\s+-R\b/,
  /\bsudo\s+dd\b/,
  // git 강제 push (공유 히스토리 파괴)
  /\bgit\s+push\b.*--force\b/,
  /\bgit\s+push\b.*-f\b/,
  // 원격 스크립트 직접 실행
  /\bcurl\b.+\|\s*(bash|sh)\b/,
  /\bwget\b.+\|\s*(bash|sh)\b/,
  // 프로세스 강제 종료 (PID 1 또는 init/systemd)
  /\bkill\s+-9\s+1\b/,
  /\bpkill\s+-9\s+(init|systemd)\b/,
];

// secret_access: 정확한 자격증명 파일 경로에만 반응 (content 키워드 false positive 방지)
// Write/Edit 툴일 때만 체크 → Read는 별도 함수에서 처리
const SECRET_WRITE_TOOLS = new Set(["Write", "Edit", "str_replace_editor"]);
const SECRET_EXACT_SUFFIXES = [
  /(?:^|\/)\.env$/, // .env (not .env.example, .env.local)
  /(?:^|\/)id_rsa$/, // SSH private key
  /(?:^|\/)id_ed25519$/, // ED25519 private key
  /(?:^|\/)id_ecdsa$/, // ECDSA private key
  /(?:^|\/)\.netrc$/, // netrc credential file
  /(?:^|\/)credentials$/, // AWS credentials etc
];
// Read 툴에서 실제 private key 파일 경로를 읽는 경우
const SECRET_READ_TOOLS = new Set(["Read", "cat"]);

const PROD_PATH_PATTERNS = [/\/prod\b/, /\/production\b/];

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

function isSecretFilePath(filePath: string): boolean {
  return SECRET_EXACT_SUFFIXES.some((pattern) => pattern.test(filePath));
}

export function detectGuardTriggers(event: HookEvent): GuardTrigger[] {
  const triggers = new Set<GuardTrigger>();
  const command = event.command ?? "";
  const filePath = event.filePath ?? "";
  const cwd = event.cwd ?? "";
  const toolName = event.toolName ?? "";

  if (DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    triggers.add("dangerous_command");
  }
  if (PROD_PATH_PATTERNS.some((pattern) => pattern.test(command) || pattern.test(filePath))) {
    triggers.add("prod_path_access");
  }
  // secret_access: Write/Edit 툴 + 정확한 자격증명 파일 경로
  //                Read 툴 + 정확한 private key 파일 경로
  if (filePath && isSecretFilePath(filePath)) {
    if (SECRET_WRITE_TOOLS.has(toolName) || SECRET_READ_TOOLS.has(toolName)) {
      triggers.add("secret_access");
    }
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

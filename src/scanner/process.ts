/**
 * Process utilities for the scanner.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MarmonitorConfig } from "../config/index.js";
import type { RuntimeSource } from "../types.js";
import {
  PROCESS_CWD_TTL_MS,
  PROCESS_START_TTL_MS,
  processCwdCache,
  processStartCache,
} from "./cache.js";

export const execFileAsync = promisify(execFile);

/**
 * Environment for external commands whose output we parse.
 *
 * `ps -o lstart=` renders through LC_TIME, so a Korean or German locale emits
 * "2026년 8월 17일 월요일 16시 27분 49초" / "Mo. 17 Aug. 16:27:49 2026" — neither
 * of which `new Date()` can parse. Pinning the locale keeps the output in the
 * one format our parsers were written against.
 */
function parseableOutputEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C" };
}

/**
 * Parse a `ps -o lstart=` line into epoch seconds.
 *
 * Exported for tests: the locale that produced a given line cannot be recreated
 * on an arbitrary CI runner, so the parser is exercised with captured output
 * instead of a live `ps` call.
 */
export function parsePsLstart(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = new Date(trimmed).getTime();
  // A non-C locale (or any unexpected format) yields NaN here. Returning it
  // would poison every downstream comparison — NaN passes `>` thresholds and
  // silently disables mtime prefilters — and the value is cached for minutes.
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

/** Get process cwd via lsof (fallback for non-Claude agents) */
export async function getProcessCwd(pid: number): Promise<string | undefined> {
  const cached = processCwdCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < PROCESS_CWD_TTL_MS) {
    return cached.cwd;
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-p", String(pid), "-Fn"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    const match = stdout.split("\n").find((line) => line.startsWith("n/"));
    const cwd = match ? match.slice(1) : undefined;
    processCwdCache.set(pid, {
      checkedAt: Date.now(),
      cwd,
    });
    return cwd;
  } catch {
    processCwdCache.set(pid, {
      checkedAt: Date.now(),
      cwd: undefined,
    });
    return undefined;
  }
}

export async function getProcessStartTime(pid: number): Promise<number | undefined> {
  const cached = processStartCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < PROCESS_START_TTL_MS) {
    return cached.startedAt;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
      env: parseableOutputEnv(),
    });
    const startedAt = parsePsLstart(stdout);
    processStartCache.set(pid, {
      checkedAt: Date.now(),
      startedAt,
    });
    return startedAt;
  } catch {
    processStartCache.set(pid, {
      checkedAt: Date.now(),
      startedAt: undefined,
    });
    return undefined;
  }
}

export function detectRuntimeSource(agentName: string, cmd?: string): RuntimeSource | undefined {
  if (agentName === "Gemini") return "cli";
  if (agentName !== "Codex") return undefined;
  const normalized = (cmd ?? "").toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes(".vscode/extensions")) {
    return "vscode";
  }
  return "cli";
}

export function matchesProcessCommand(command: string, processName: string): boolean {
  return commandExecutable(command, processName) !== undefined;
}

/** Match only the command's executable, never a path or prompt in its arguments.
 * Native process names come from ps comm, so unquoted spaces in parent paths
 * are safe here. Interpreted entry points are handled separately below. */
function commandExecutable(
  command: string,
  name: string,
): { executable: string; args: string[] } | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command
    .trim()
    .match(
      new RegExp(
        `^(?:"((?:.*?[/\\\\])?${escaped})"|'((?:.*?[/\\\\])?${escaped})'|((?:.*?[/\\\\])?${escaped}))(?=\\s|$)`,
        "i",
      ),
    );
  if (!match) return undefined;
  const executable = match[1] ?? match[2] ?? match[3];
  // Do not extend an unquoted executable into subsequent command arguments.
  if (!match[1] && !match[2] && /\s[-/]|\s[^\s]*=/.test(executable)) return undefined;
  return {
    executable,
    args: commandWords(command.trim().slice(match[0].length)),
  };
}

// ps args is a display string, not lossless argv. Respect quotes when present;
// never search later words for an entry point if the first one is ambiguous.
function commandWords(command: string): string[] {
  return Array.from(
    command.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g),
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

const NODE_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
]);
const CODEX_VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-C",
  "--cd",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "--approval-mode",
  "--enable",
  "--disable",
  "--add-dir",
  "--local-provider",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
]);

/** Only the first positional CLI argument is a subcommand. Option values,
 * prompt text and arguments after `--` cannot turn a CLI into a server. */
function codexMode(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return undefined;
    if (["-h", "--help", "-V", "--version"].includes(arg)) return "help";
    if (CODEX_VALUE_OPTIONS.has(arg)) {
      i++;
    } else if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

type CodexProcessRole = "session" | "server" | "sandbox" | "utility";

// A Codex binary is also a launcher for non-agent runtimes and management
// commands. Only session-bearing invocations belong in the CLI inventory.
// Keep mode interpretation separate from executable identity and file binding.
const CODEX_NON_SESSION_MODES: Record<string, Exclude<CodexProcessRole, "session">> = {
  "app-server": "server",
  "exec-server": "server",
  "mcp-server": "server",
  sandbox: "sandbox",
  agents: "utility",
  login: "utility",
  logout: "utility",
  mcp: "utility",
  plugin: "utility",
  "remote-control": "utility",
  app: "utility",
  completion: "utility",
  update: "utility",
  doctor: "utility",
  debug: "utility",
  apply: "utility",
  a: "utility",
  queue: "utility",
  archive: "utility",
  delete: "utility",
  "migrate-rollouts": "utility",
  "migrate-nfs-db": "utility",
  unarchive: "utility",
  cloud: "utility",
  features: "utility",
  help: "utility",
};

function codexProcessRole(args: string[]): CodexProcessRole {
  const mode = codexMode(args);
  return mode && Object.hasOwn(CODEX_NON_SESSION_MODES, mode)
    ? CODEX_NON_SESSION_MODES[mode]
    : "session";
}

const NODE_ENTRY_POINTS: Record<string, RegExp> = {
  "Claude Code": /[/\\]@anthropic-ai[/\\]claude-code[/\\]cli\.js$/i,
  Codex: /[/\\]@openai[/\\]codex[/\\]bin[/\\]codex\.js$/i,
  Gemini: /[/\\]@google[/\\]gemini-cli[/\\](?:dist[/\\])?(?:src[/\\])?index\.js$/i,
};

function nodeEntryPoint(command: string): { executable: string; args: string[] } | undefined {
  const node = commandExecutable(command, "node") ?? commandExecutable(command, "nodejs");
  if (!node) return undefined;
  for (let i = 0; i < node.args.length; i++) {
    const arg = node.args[i];
    // Eval/print input is code, not an agent entry script.
    if (["-e", "--eval", "-p", "--print"].includes(arg) || /^(--eval|--print)=/.test(arg))
      return undefined;
    if (NODE_VALUE_OPTIONS.has(arg)) {
      i++;
    } else if (arg === "--") {
      return { executable: node.args[i + 1] ?? "", args: node.args.slice(i + 2) };
    } else if (!arg.startsWith("-")) {
      return { executable: arg, args: node.args.slice(i + 1) };
    }
  }
  return undefined;
}

/** Match a process against agent signatures using process name first, then cmd fallback. */
export function detectAgentFromProcessSignature(
  proc: { name: string; cmd?: string },
  config: MarmonitorConfig,
): string | null {
  const name = proc.name.toLowerCase();
  const command = proc.cmd ?? "";
  const script = name === "node" || name === "nodejs" ? nodeEntryPoint(command) : undefined;
  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    for (const pname of agentConfig.processNames) {
      const native = name === pname.toLowerCase();
      const entry =
        native || ((name === "node" || name === "nodejs") && !script)
          ? commandExecutable(command, pname)
          : script &&
              (script.executable.split(/[/\\]/).pop()?.toLowerCase() === pname.toLowerCase() ||
                NODE_ENTRY_POINTS[agentName]?.test(script.executable))
            ? script
            : undefined;
      // An unavailable command retains the native-name fallback. A present
      // but contradictory command is not evidence of an agent CLI.
      if (!entry && !(native && !command)) continue;
      if (
        entry &&
        /[/\\](?:claude|codex)\.app[/\\]contents[/\\]macos[/\\](?:claude|codex)$/i.test(
          entry.executable,
        )
      )
        return null;
      if (
        entry?.args.some((arg) => /^--type=(utility|renderer|gpu-process|zygote|broker)$/.test(arg))
      )
        return null;
      // Linux Electron may advertise /proc/self/exe instead of its app path.
      if (agentName === "Codex" && entry) {
        if (codexProcessRole(entry.args) !== "session") return null;
      }
      return agentName;
    }
  }
  return null;
}

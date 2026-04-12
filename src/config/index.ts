/**
 * Configuration loader for marmonitor.
 * Loads settings from XDG-compliant paths with fallback.
 *
 * Priority:
 *   1. $XDG_CONFIG_HOME/marmonitor/settings.json
 *   2. ~/.config/marmonitor/settings.json
 *   3. ~/.marmonitor.json (legacy fallback, read-only)
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Full config shape with all fields required (after merge with defaults) */
export interface MarmonitorConfig {
  status: {
    activeCpuThreshold: number; // CPU% above this = Active
    stalledAfterMin: number; // minutes idle before Stalled
    minMemoryMb: number; // skip processes below this (spawners/wrappers)
    phaseDecay: {
      thinking: number;
      tool: number;
      permission: number;
      done: number;
    };
    stdoutHeuristic: {
      approvalPatterns: string[];
      clearPatterns: string[];
    };
  };
  display: {
    showDead: boolean;
    sortBy: "cwd" | "agent" | "status" | "pid";
    attentionLimit: number;
    statuslineAttentionLimit: number;
  };
  agents: Record<
    string,
    {
      processNames: string[];
    }
  >;
  intervention: {
    enabled: boolean;
    mode: "alert" | "hold" | "block";
    requireConfirmation: boolean;
    defaultAction: "ignore" | "alert" | "hold" | "block";
    rules: Array<{
      id: string;
      enabled: boolean;
      trigger: string;
      action?: "ignore" | "alert" | "hold" | "block";
      agents?: Array<"claude" | "codex" | "gemini">;
      runtimeSources?: Array<"cli" | "vscode" | "unknown">;
      severity?: "low" | "medium" | "high" | "critical";
      match?: {
        commandRegex?: string;
        cwdPrefix?: string;
        toolNames?: string[];
      };
      note?: string;
    }>;
  };
  integration: {
    tmux: {
      keys: {
        attentionPopup: string;
        jumpPopup: string;
        dockToggle: string;
        directJump: string[];
      };
      badgeStyle: "basic" | "basic-mono" | "block" | "block-mono" | "text" | "text-mono";
    };
    wezterm: {
      enabled: boolean;
      statusTtlSec: number;
    };
    banner: {
      install: boolean;
      runtime: boolean;
    };
  };
  paths: {
    claudeProjects: string[];
    claudeSessions: string[];
    codexSessions: string[];
    extraRoots: string[];
  };
  performance: {
    snapshotTtlMs: number;
    statuslineTtlMs: number;
    stdoutHeuristicTtlMs: number;
    daemonIntervalSec: number;
    activityRetentionDays: number;
  };
  alerts: {
    /** 알림 시스템 마스터 토글 */
    enabled: boolean;
    /** macOS/Linux 데스크탑 알림 */
    desktop: boolean;
    /** alerts.log 파일 기록 */
    log: boolean;
    /** 컨텍스트 경고 임계값 (0~1). 0 = 비활성화. 기본 1.0 (비활성) */
    contextWarnThreshold: number;
    /** 컨텍스트 위험 임계값 (0~1). 기본 0.85 */
    contextCritThreshold: number;
  };
}

const DEFAULTS: MarmonitorConfig = {
  status: {
    activeCpuThreshold: 0.5,
    stalledAfterMin: 30,
    minMemoryMb: 5,
    phaseDecay: {
      thinking: 20,
      tool: 30,
      permission: 0,
      done: 5,
    },
    stdoutHeuristic: {
      approvalPatterns: [
        "would you like to",
        "approve this",
        "approve the following",
        "confirm",
        "confirmation required",
        "action required",
        "allow execution of:",
      ],
      clearPatterns: [
        "reading files",
        "applying patch",
        "running tests",
        "running command",
        "edited",
        "changes applied",
      ],
    },
  },
  display: {
    showDead: false,
    sortBy: "cwd",
    attentionLimit: 10,
    statuslineAttentionLimit: 5,
  },
  agents: {
    "Claude Code": { processNames: ["claude"] },
    Codex: { processNames: ["codex"] },
    Gemini: { processNames: ["gemini"] },
  },
  intervention: {
    enabled: false,
    mode: "alert",
    requireConfirmation: true,
    defaultAction: "alert",
    rules: [],
  },
  integration: {
    tmux: {
      keys: {
        attentionPopup: "a",
        jumpPopup: "j",
        dockToggle: "m",
        directJump: ["M-1", "M-2", "M-3", "M-4", "M-5"],
      },
      badgeStyle: "basic" as const,
    },
    wezterm: {
      enabled: false,
      statusTtlSec: 15,
    },
    banner: {
      install: true,
      runtime: false,
    },
  },
  paths: {
    claudeProjects: [],
    claudeSessions: [],
    codexSessions: [],
    extraRoots: [],
  },
  performance: {
    snapshotTtlMs: 2000,
    statuslineTtlMs: 2000,
    stdoutHeuristicTtlMs: 2000,
    daemonIntervalSec: 2,
    activityRetentionDays: 7,
  },
  alerts: {
    enabled: true,
    desktop: true,
    log: true,
    contextWarnThreshold: 1.0, // 기본 비활성 (0.70으로 설정 시 활성화)
    contextCritThreshold: 0.85,
  },
};

function cloneDefaults(): MarmonitorConfig {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/** Get config search paths in priority order */
export function getConfigSearchPaths(): string[] {
  const home = homedir();
  const xdgHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config");

  return [join(xdgHome, "marmonitor", "settings.json"), join(home, ".marmonitor.json")];
}

/** Find the config file path (first existing one wins) */
function findConfigPath(): string | undefined {
  const candidates = getConfigSearchPaths();

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep merge user config onto defaults */
function deepMerge(defaults: JsonObject, overrides: JsonObject): JsonObject {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    const val = overrides[key];
    const defaultVal = defaults[key];
    if (isJsonObject(val) && isJsonObject(defaultVal)) {
      result[key] = deepMerge(defaultVal, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** Load config, merging user overrides onto defaults */
export async function loadConfig(customPath?: string): Promise<MarmonitorConfig> {
  const configPath = customPath ?? findConfigPath();

  if (!configPath) return cloneDefaults();

  try {
    const raw = await readFile(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    if (!isJsonObject(userConfig)) return cloneDefaults();
    return deepMerge(
      cloneDefaults() as unknown as JsonObject,
      userConfig,
    ) as unknown as MarmonitorConfig;
  } catch {
    // Malformed or unreadable config — use defaults silently
    return cloneDefaults();
  }
}

/** Get default config (no file I/O) */
export function getDefaults(): MarmonitorConfig {
  return cloneDefaults();
}

/** Get the expected config directory path (for init/display) */
export function getConfigDir(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdgHome, "marmonitor");
}

/** Get the default writable settings path */
export function getDefaultConfigPath(): string {
  return join(getConfigDir(), "settings.json");
}

/** Resolve the config path that would actually be used */
export function resolveConfigPath(customPath?: string): string | undefined {
  return customPath ?? findConfigPath();
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function parsePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(expandUserPath);
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(expandUserPath)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export interface RuntimeDataPaths {
  claudeProjects: string[];
  claudeSessions: string[];
  codexSessions: string[];
  extraRoots: string[];
}

export function resolveRuntimeDataPaths(config: MarmonitorConfig): RuntimeDataPaths {
  const claudeHome = process.env.MARMONITOR_CLAUDE_HOME
    ? expandUserPath(process.env.MARMONITOR_CLAUDE_HOME)
    : undefined;
  const codexHome = process.env.MARMONITOR_CODEX_HOME
    ? expandUserPath(process.env.MARMONITOR_CODEX_HOME)
    : undefined;

  return {
    claudeProjects: uniquePaths([
      ...parsePathList(process.env.MARMONITOR_CLAUDE_PROJECTS),
      ...config.paths.claudeProjects,
      ...(claudeHome ? [join(claudeHome, "projects")] : []),
      join(homedir(), ".claude", "projects"),
    ]),
    claudeSessions: uniquePaths([
      ...parsePathList(process.env.MARMONITOR_CLAUDE_SESSIONS),
      ...config.paths.claudeSessions,
      ...(claudeHome ? [join(claudeHome, "sessions")] : []),
      join(homedir(), ".claude", "sessions"),
    ]),
    codexSessions: uniquePaths([
      ...parsePathList(process.env.MARMONITOR_CODEX_SESSIONS),
      ...config.paths.codexSessions,
      ...(codexHome ? [join(codexHome, "sessions")] : []),
      join(homedir(), ".codex", "sessions"),
    ]),
    extraRoots: uniquePaths(config.paths.extraRoots),
  };
}

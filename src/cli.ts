import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { renderInstallBanner, renderRuntimeBanner } from "./banner/index.js";
import {
  getConfigDir,
  getConfigSearchPaths,
  getDefaultConfigPath,
  loadConfig,
  resolveConfigPath as resolveLoadedConfigPath,
} from "./config/index.js";
import {
  detectGuardTriggers,
  evaluateGuard,
  formatGuardOutput,
  parseHookEvent,
  readStdin,
} from "./guard/index.js";
import {
  applyTerminalStyle,
  printAttention,
  printAttentionJson,
  printCleanJson,
  printCleanPlan,
  printDock,
  printJumpAttentionChooser,
  printJumpJson,
  printJumpResult,
  printStatus,
  printStatusJson,
  printStatusline,
  renderJumpAttentionChooser,
  renderStatusline,
  renderUnavailableStatusline,
} from "./output/index.js";
import {
  buildJumpAttentionItems,
  parseSelectionInput,
  selectJumpAttentionItem,
  selectJumpAttentionItemOnPage,
  selectUnmatchedTargets,
} from "./output/utils.js";
import { TERMINAL_RESTORE_SEQUENCE, formatProcessFailure } from "./process-safety.js";
import { detectClaudePhase } from "./scanner/claude.js";
import { detectCodexPhase, indexCodexSessions, matchCodexSession } from "./scanner/codex.js";
import { isDaemonRunning, readDaemonPid, readDaemonSnapshot } from "./scanner/daemon-utils.js";
import { parseGeminiSession } from "./scanner/gemini.js";
import { scanAgents } from "./scanner/index.js";
import { loadRegistryFromFile } from "./scanner/session-registry.js";
import { detectCliStdoutPhase } from "./scanner/status.js";
import {
  captureTmuxPaneOutput,
  findActiveAgentPid,
  jumpToAgent,
  resolveTmuxJumpTarget,
} from "./tmux/index.js";
import { getClientTty, jumpBack } from "./tmux/jump-anchor.js";
import { findClickedAgent, parseStatusClickToken } from "./tmux/status-click.js";
import type { AgentSession } from "./types.js";
import { VERSION } from "./version.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stdinRawModeActive = false;
let processExiting = false;

function setStdinRawMode(enabled: boolean): void {
  const stdin = process.stdin;
  if (!("setRawMode" in stdin) || typeof stdin.setRawMode !== "function") return;
  stdin.setRawMode(enabled);
  stdinRawModeActive = enabled;
}

function restoreTerminalState(): void {
  if (stdinRawModeActive) {
    try {
      setStdinRawMode(false);
    } catch {
      // best effort only
    }
  }

  try {
    process.stdin.pause();
  } catch {
    // best effort only
  }

  if (process.stdout.isTTY) {
    process.stdout.write(TERMINAL_RESTORE_SEQUENCE);
  }
}

function exitWithCleanup(code: number, message?: string): never {
  if (processExiting) {
    process.exit(code);
  }

  processExiting = true;
  restoreTerminalState();

  if (message) {
    console.error(message);
  }

  process.exit(code);
}

function installProcessSafetyHandlers(): void {
  process.on("uncaughtException", (error) => {
    exitWithCleanup(1, formatProcessFailure(error));
  });

  process.on("unhandledRejection", (reason) => {
    exitWithCleanup(1, formatProcessFailure(reason));
  });

  process.on("SIGINT", () => exitWithCleanup(0));
  process.on("SIGTERM", () => exitWithCleanup(0));
}

function buildHelpAppendix(): string {
  return [
    "Core workflows:",
    "  status        Full one-shot inventory of local AI sessions",
    "  attention     Priority list for sessions that need review",
    "  activity      Show recent tool usage and tokens per session",
    "  watch         Live full-screen monitor",
    "  dock          Persistent tmux-friendly monitor",
    "  --statusline  Status bar output for tmux",
    "  clean         Review or kill unmatched leftovers",
    "  debug-phase   Inspect raw phase signals for one PID",
    "  guard         Claude hook evaluator; fail-open on malformed input/errors",
    "  settings-*    Locate, inspect, or initialize settings.json",
    "",
    "Statusline formats:",
    "  compact | standard | extended | tmux-badges",
    "",
    "Config helper commands:",
    "  settings-path           Show config search order and active file",
    "  settings-show           Print the merged runtime config",
    "  settings-init           Write a starter settings.json",
    "  settings-init --advanced  Print or write the full advanced sample",
    "",
    "Settings groups:",
    "  display       Attention list, statusline density, sorting",
    "  integration   tmux keys, paused terminal integrations, banner behavior",
    "  paths         Runtime data path overrides for Claude/Codex",
    "  status        Thresholds and phase/approval heuristics",
    "  performance   Snapshot/cache TTL tuning",
    "  intervention  Guard and policy rules (advanced / optional)",
    "",
    "Phase icons:",
    "  ⏳ permission   Waiting for tool approval (user input needed)",
    "  🤔 thinking     AI generating response",
    "  🔧 tool         Approved tool executing",
    "  ✅ done         Response complete",
    "",
    "Status labels:",
    "  [Active]    CPU activity detected",
    "  [Idle]      Process alive, no recent activity",
    "  [Stalled]   No activity for extended period",
    "  [Dead]      Session file exists but process gone",
    "  [Unmatched] AI process without matching session",
    "",
    "Common settings:",
    "  display.attentionLimit / display.statuslineAttentionLimit",
    "  integration.tmux.badgeStyle",
    "  integration.tmux.keys.*",
    "  paths.* (runtime data path overrides)",
    "",
    "Daemon:",
    "  start         Start background scan daemon (required before use)",
    "  stop          Stop daemon",
    "  restart       Restart daemon (e.g. after update)",
    "  activity      Show what each session did (tool calls + tokens)",
    "",
    "Activity log options:",
    "  --pid <pid>       Filter by process ID",
    "  --session <sid>   Filter by session ID prefix",
    "  --days <n>        Number of days to show (default: 1)",
    "  --json            JSON output",
    "",
    "Navigation:",
    "  jump --pid <pid>  Jump to a session's tmux pane",
    "  jump --attention  Interactive jump chooser",
    "  jump-back         Return to pane before last jump",
    "",
    "Integration:",
    "  setup tmux              Add tmux plugin to ~/.tmux.conf",
    "  update-integration      Check tmux plugin sync status",
    "  uninstall-integration   Remove tmux integration",
    "",
    "Default tmux shortcuts:",
    "  Prefix+a      Attention popup",
    "  Prefix+j      Jump popup",
    "  Prefix+m      Toggle dock",
    "  Option+1..5   Direct jump to numbered attention sessions",
    "  Option+`      Jump back to previous pane",
    "",
    `Config location: ${getConfigDir()}/settings.json`,
    "Common settings:",
    "  display.attentionLimit / display.statuslineAttentionLimit",
    "  integration.tmux.keys.*",
    "  paths.* (runtime data path overrides)",
    "",
    "Shortcuts can be customized in settings.json:",
    "  integration.tmux.keys = { attentionPopup, jumpPopup, dockToggle, directJump[] }",
  ].join("\n");
}

function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  }
}

async function promptSelectionAction(
  maxChoice: number,
  currentPage = 1,
  totalPages = 1,
): Promise<ReturnType<typeof parseSelectionInput>> {
  if (!process.stdin.isTTY || maxChoice < 1) return undefined;

  const prompt =
    totalPages > 1
      ? maxChoice >= 10
        ? "\n←/→ page, 1-9 to jump, 0 for 10, q to cancel: "
        : `\n←/→ page, 1-${maxChoice} to jump, q to cancel: `
      : maxChoice >= 10
        ? "\n1-9 to jump, 0 for 10, q to cancel: "
        : `\n1-${maxChoice} to jump, q to cancel: `;
  process.stdout.write(prompt);

  return await new Promise<ReturnType<typeof parseSelectionInput>>((resolve) => {
    const stdin = process.stdin;
    const restoreRawMode = "setRawMode" in stdin && typeof stdin.setRawMode === "function";

    const cleanup = (): void => {
      if (restoreRawMode) setStdinRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      const input = chunk.toString("utf8");
      if (input === "\u0003") {
        cleanup();
        exitWithCleanup(130);
      }
      const action = parseSelectionInput(input, maxChoice, currentPage, totalPages);
      if (action) {
        cleanup();
        resolve(action);
      }
    };

    if (restoreRawMode) setStdinRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const program = new Command();

program
  .name("marmonitor")
  .description("AI agent monitoring tool")
  .version(VERSION, "-v, --version", "output the version number");
program.helpCommand(false);
program.showHelpAfterError();
program.addHelpText("beforeAll", `${renderInstallBanner()}\n`);
program.addHelpText("afterAll", `\n${buildHelpAppendix()}\n`);

program
  .command("help [command]")
  .description("Show marmonitor help, commands, and shortcuts")
  .action((commandName?: string) => {
    if (!commandName) {
      program.outputHelp();
      return;
    }

    const target = program.commands.find((command) => command.name() === commandName);
    if (!target) {
      console.error(`Unknown command: ${commandName}`);
      process.exit(1);
    }

    target.outputHelp();
  });

program
  .command("banner")
  .description("Preview install or runtime banner")
  .option("--install", "Render install-style banner")
  .option("--runtime", "Render runtime-style banner")
  .option("--active <n>", "Active session count for runtime banner")
  .action(async (opts) => {
    const active = typeof opts.active === "string" ? Number.parseInt(opts.active, 10) : undefined;
    if (opts.install && opts.runtime) {
      console.error("Use only one of --install or --runtime.");
      process.exit(1);
    }
    if (opts.install) {
      console.log(renderInstallBanner());
      return;
    }
    console.log(renderRuntimeBanner(Number.isNaN(active) ? undefined : active));
  });

function resolveConfigPath(opts: { config?: string }): string | undefined {
  return opts.config ?? program.opts<{ config?: string }>().config;
}

function resolveStatuslineWidth(value: string | undefined): number | undefined {
  if (value !== undefined) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  return process.stdout.isTTY && typeof process.stdout.columns === "number"
    ? process.stdout.columns
    : undefined;
}

function buildMinimalConfigSample(): string {
  return JSON.stringify(
    {
      display: {
        attentionLimit: 10,
        statuslineAttentionLimit: 5,
      },
      integration: {
        tmux: {
          badgeStyle: "basic",
          keys: {
            attentionPopup: "a",
            jumpPopup: "j",
            dockToggle: "m",
            directJump: ["M-1", "M-2", "M-3", "M-4", "M-5"],
          },
        },
      },
    },
    null,
    2,
  );
}

function buildAdvancedConfigSample(): string {
  return JSON.stringify(
    {
      status: {
        stalledAfterMin: 20,
        phaseDecay: {
          thinking: 20,
          tool: 30,
          permission: 0,
          done: 5,
        },
        stdoutHeuristic: {
          approvalPatterns: ["would you like to", "please approve"],
          clearPatterns: ["applying patch", "running tests"],
        },
      },
      display: {
        attentionLimit: 10,
        statuslineAttentionLimit: 5,
      },
      integration: {
        tmux: {
          badgeStyle: "basic",
          keys: {
            attentionPopup: "a",
            jumpPopup: "j",
            dockToggle: "m",
            directJump: ["M-1", "M-2", "M-3", "M-4", "M-5"],
          },
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
        snapshotTtlMs: 5000,
        statuslineTtlMs: 5000,
        stdoutHeuristicTtlMs: 5000,
      },
    },
    null,
    2,
  );
}

program
  .command("settings-path")
  .description("Show config search paths and the currently resolved config file")
  .option("--json", "Output as JSON")
  .option("--config <path>", "Path to settings.json")
  .action((opts) => {
    const customPath = resolveConfigPath(opts);
    const resolvedPath = resolveLoadedConfigPath(customPath);
    const payload = {
      configDir: getConfigDir(),
      defaultPath: getDefaultConfigPath(),
      searchPaths: customPath ? [customPath] : getConfigSearchPaths(),
      resolvedPath: resolvedPath ?? null,
      source: customPath ? "custom" : resolvedPath ? "discovered" : "default",
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Config dir: ${payload.configDir}`);
    console.log(`Default path: ${payload.defaultPath}`);
    console.log(`Resolved path: ${payload.resolvedPath ?? "(none, defaults only)"}`);
    console.log("Search paths:");
    for (const path of payload.searchPaths) {
      console.log(`  - ${path}`);
    }
  });

program
  .command("settings-show")
  .description("Show the merged runtime configuration")
  .option("--json", "Output as JSON")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const customPath = resolveConfigPath(opts);
    const resolvedPath = resolveLoadedConfigPath(customPath);
    const config = await loadConfig(customPath);
    const payload = {
      resolvedPath: resolvedPath ?? null,
      config,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Resolved path: ${payload.resolvedPath ?? "(none, defaults only)"}`);
    console.log(JSON.stringify(config, null, 2));
  });

program
  .command("settings-init")
  .description("Write a starter settings.json file")
  .option("--advanced", "Write the advanced sample instead of the minimal sample")
  .option("--stdout", "Print the sample to stdout instead of writing a file")
  .option("--force", "Overwrite an existing settings file")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const targetPath = resolveConfigPath(opts) ?? getDefaultConfigPath();
    const sample = opts.advanced ? buildAdvancedConfigSample() : buildMinimalConfigSample();

    if (opts.stdout) {
      console.log(sample);
      return;
    }

    try {
      await stat(targetPath);
      if (!opts.force) {
        console.error(`Config already exists: ${targetPath}`);
        console.error("Use --force to overwrite or --stdout to preview the sample.");
        process.exit(1);
      }
    } catch {
      // target does not exist, continue
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${sample}\n`, "utf-8");
    console.log(`Wrote ${opts.advanced ? "advanced" : "minimal"} config to ${targetPath}`);
  });

function resolveAttentionLimit(
  opts: { limit?: string },
  configuredLimit: number,
  interactive = false,
): number {
  const raw = Number(opts.limit);
  const fallback = Number.isFinite(raw) && raw > 0 ? raw : configuredLimit;
  if (!interactive) return Math.max(Math.floor(fallback), 1);
  return Math.min(Math.max(Math.floor(fallback), 1), 10);
}

function statuslineCacheFile(format: string, attentionLimit: number, width?: number): string {
  const widthKey = width && width > 0 ? String(width) : "auto";
  return join(tmpdir(), "marmonitor", `statusline-${format}-${attentionLimit}-${widthKey}.txt`);
}

/** Read cached statusline. When activePanePid is provided, the cache is
 *  only valid if the stored panePid (first line) matches — otherwise the
 *  active-window highlight would be stale. Returns {content, panePid}. */
async function readCachedStatusline(
  format: string,
  attentionLimit: number,
  width: number | undefined,
  ttlMs: number,
): Promise<{ content: string; panePid: number | undefined } | undefined> {
  const path = statuslineCacheFile(format, attentionLimit, width);
  try {
    const fileStat = await stat(path);
    if (Date.now() - fileStat.mtimeMs > ttlMs) return undefined;
    const raw = (await readFile(path, "utf-8")).trimEnd();
    const newline = raw.indexOf("\n");
    if (newline === -1) return { content: raw, panePid: undefined };
    const firstLine = raw.slice(0, newline);
    const pid = Number.parseInt(firstLine, 10);
    if (Number.isFinite(pid)) {
      return { content: raw.slice(newline + 1), panePid: pid };
    }
    return { content: raw, panePid: undefined };
  } catch {
    return undefined;
  }
}

async function writeCachedStatusline(
  format: string,
  attentionLimit: number,
  width: number | undefined,
  value: string,
  activePanePid?: number,
): Promise<void> {
  const path = statuslineCacheFile(format, attentionLimit, width);
  const data = activePanePid ? `${activePanePid}\n${value}` : value;
  try {
    await mkdir(join(tmpdir(), "marmonitor"), { recursive: true });
    await writeFile(path, data, "utf-8");
  } catch {
    // cache failures must never break statusline rendering
  }
}

const DAEMON_DIR = join(tmpdir(), "marmonitor");
const DAEMON_PID_PATH = join(DAEMON_DIR, "daemon.pid");
const DAEMON_SNAPSHOT_PATH = join(DAEMON_DIR, "daemon-snapshot.json");
const DAEMON_NOT_RUNNING = "Daemon not running. Run: marmonitor start";

async function getAgentsSnapshot(): Promise<AgentSession[]> {
  return (await readDaemonSnapshot(DAEMON_SNAPSHOT_PATH, 5_000)) as AgentSession[];
}

async function requireDaemonSnapshot(): Promise<AgentSession[]> {
  const agents = await getAgentsSnapshot();
  if (agents.length === 0) {
    console.error(DAEMON_NOT_RUNNING);
    process.exit(1);
  }
  return agents;
}

async function loadSessionRegistry(): Promise<
  Map<string, import("./scanner/session-registry.js").SessionRegistryRecord>
> {
  const registry = new Map<string, import("./scanner/session-registry.js").SessionRegistryRecord>();
  await loadRegistryFromFile(join(getConfigDir(), "session-registry.json"), registry);
  return registry;
}

program
  .option("--statusline", "One-line summary for tmux statusbar")
  .option(
    "--statusline-format <format>",
    "Statusline format: compact | standard | extended | tmux-badges",
    "compact",
  )
  .option("--width <n>", "Render width hint for responsive statusline compaction")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const validFormats = ["compact", "standard", "extended", "tmux-badges", "wezterm-pills"];
    if (opts.statuslineFormat && !validFormats.includes(opts.statuslineFormat)) {
      console.error(`Invalid format: ${opts.statuslineFormat}. Valid: ${validFormats.join(", ")}`);
      process.exit(1);
    }
    if (opts.statusline) {
      try {
        const config = await loadConfig(resolveConfigPath(opts));
        if (opts.statuslineFormat === "wezterm-pills") {
          console.error("wezterm-pills is paused. Use tmux-badges or another tmux format.");
          process.exit(1);
        }
        const attentionLimit = config.display.statuslineAttentionLimit;
        const width = resolveStatuslineWidth(opts.width);
        const isTmuxBadges = opts.statuslineFormat === "tmux-badges";
        // Try cache first. For tmux-badges the cached panePid is checked
        // against the live pane only on cache hit — the tmux call is
        // deferred so cache-miss paths pay for it just once.
        const cached = await readCachedStatusline(
          opts.statuslineFormat,
          attentionLimit,
          width,
          config.performance.statuslineTtlMs,
        );
        if (cached) {
          if (isTmuxBadges && cached.panePid !== undefined) {
            const { getActiveTmuxPanePid } = await import("./tmux/index.js");
            const currentPanePid = await getActiveTmuxPanePid();
            if (currentPanePid !== cached.panePid) {
              // Active pane changed — fall through to re-render
            } else {
              console.log(cached.content);
              return;
            }
          } else {
            console.log(cached.content);
            return;
          }
        }
        const agents = await getAgentsSnapshot();
        if (agents.length === 0) {
          console.log(renderUnavailableStatusline(opts.statuslineFormat));
          return;
        }
        // Check jump-back anchor and resolve active agent for tmux-badges
        let hasJumpAnchor = false;
        let activeAgentPid: number | undefined;
        let activePanePid: number | undefined;
        if (isTmuxBadges) {
          const { tmpdir: td } = await import("node:os");
          const { join: pj } = await import("node:path");
          const { loadJumpAnchor } = await import("./tmux/jump-anchor.js");
          const { getActiveTmuxPanePid } = await import("./tmux/index.js");
          const agentPids = agents.map((a) => a.pid);
          const [tty, panePid] = await Promise.all([getClientTty(), getActiveTmuxPanePid()]);
          activePanePid = panePid;
          activeAgentPid = await findActiveAgentPid(agentPids, activePanePid);
          if (tty) {
            hasJumpAnchor = Boolean(
              await loadJumpAnchor(pj(td(), "marmonitor", "jump-anchors.json"), tty),
            );
          }
        }
        const rendered = await renderStatusline(
          agents,
          opts.statuslineFormat,
          attentionLimit,
          width,
          config.integration.tmux.badgeStyle,
          hasJumpAnchor,
          activeAgentPid,
        );
        await writeCachedStatusline(
          opts.statuslineFormat,
          attentionLimit,
          width,
          rendered,
          activePanePid,
        );
        console.log(rendered);
        return;
      } catch {
        console.log(renderUnavailableStatusline(opts.statuslineFormat));
        return;
      }
    }
    console.log("TUI dashboard not yet implemented. Use 'marmonitor status' for now.");
  });

program
  .command("status")
  .description("Show current AI agent status")
  .option("--json", "Output as JSON")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const agents = await requireDaemonSnapshot();
    const config = await loadConfig(resolveConfigPath(opts));
    applyTerminalStyle(config.integration.tmux.badgeStyle);
    if (opts.json) {
      await printStatusJson(agents);
    } else {
      await printStatus(agents);

      // Show setup hint if tmux plugin not configured
      try {
        const { hasMarmonitorPlugin } = await import("./tmux/setup.js");
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const confPath = join(homedir(), ".tmux.conf");
        if (!(await hasMarmonitorPlugin(confPath))) {
          console.log("\ntmux integration not configured.");
          console.log("  Run: marmonitor setup tmux\n");
        }
      } catch {
        // silent — setup check must never break status
      }
    }
  });

program
  .command("attention")
  .description("Show prioritized sessions that need attention, optionally jump to one")
  .option("--json", "Output as JSON")
  .option("--interactive", "Choose an attention item and jump to its tmux pane")
  .option("--pid <pid>", "Jump to AI session by PID")
  .option("--attention-index <n>", "Jump to Nth attention item directly")
  .option("--limit <n>", "Max items to show", "12")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const agents = await requireDaemonSnapshot();
    const config = await loadConfig(resolveConfigPath(opts));
    applyTerminalStyle(config.integration.tmux.badgeStyle);
    const limit = resolveAttentionLimit(opts, config.display.attentionLimit);
    const interactiveLimit = resolveAttentionLimit(opts, config.display.attentionLimit, true);

    const useDirectPid = typeof opts.pid === "string";
    const useDirectIndex = typeof opts.attentionIndex === "string";
    const useInteractive = Boolean(opts.interactive);

    // Direct jump by PID
    if (useDirectPid) {
      const pid = Number.parseInt(opts.pid, 10);
      if (Number.isNaN(pid)) {
        console.error(`Invalid pid: ${opts.pid}`);
        process.exit(1);
      }
      const agent = agents.find((a) => a.pid === pid);
      if (!agent) {
        const result = {
          found: false,
          executed: false,
          insideTmux: Boolean(process.env.TMUX),
          pid,
          message: `AI session not found for pid ${pid}.`,
        };
        if (opts.json) {
          printJumpJson(result);
        } else {
          printJumpResult(result);
        }
        process.exit(1);
      }
      const result = await jumpToAgent(agent);
      if (opts.json) {
        printJumpJson(result);
      } else {
        printJumpResult(result);
      }
      if (!result.found) process.exit(1);
      return;
    }

    // Direct jump by attention index
    if (useDirectIndex) {
      const selection = Number.parseInt(opts.attentionIndex, 10);
      if (Number.isNaN(selection) || selection < 1) {
        console.error(`Invalid attention index: ${opts.attentionIndex}`);
        process.exit(1);
      }
      const item = selectJumpAttentionItem(agents, selection);
      if (!item) {
        console.error(`No jumpable attention item at index ${selection}.`);
        process.exit(1);
      }
      const agent = agents.find((a) => a.pid === item.pid);
      if (!agent) {
        console.error(`AI session not found for pid ${item.pid}.`);
        process.exit(1);
      }
      const result = await jumpToAgent(agent);
      if (opts.json) {
        printJumpJson(result);
      } else {
        printJumpResult(result);
      }
      if (!result.found) process.exit(1);
      return;
    }

    // Interactive chooser
    if (useInteractive) {
      if (opts.json) {
        console.error("--interactive cannot be combined with --json.");
        process.exit(1);
      }
      if (!process.stdin.isTTY) {
        console.error("--interactive requires an interactive terminal.");
        process.exit(1);
      }
      const totalItems = buildJumpAttentionItems(agents).length;
      const totalPages = Math.max(1, Math.ceil(totalItems / interactiveLimit));
      let currentPage = 1;
      let item: ReturnType<typeof selectJumpAttentionItemOnPage>;
      while (true) {
        clearScreen();
        console.log(renderJumpAttentionChooser(agents, currentPage, interactiveLimit));
        const pageItemCount = Math.min(
          interactiveLimit,
          Math.max(totalItems - (currentPage - 1) * interactiveLimit, 0),
        );
        const action = await promptSelectionAction(pageItemCount, currentPage, totalPages);
        if (!action || action.kind === "cancel") return;
        if (action.kind === "next") {
          currentPage = Math.min(currentPage + 1, totalPages);
          continue;
        }
        if (action.kind === "prev") {
          currentPage = Math.max(currentPage - 1, 1);
          continue;
        }
        item = selectJumpAttentionItemOnPage(
          agents,
          currentPage,
          action.selection,
          interactiveLimit,
        );
        break;
      }
      if (!item) {
        console.error("Invalid selection.");
        process.exit(1);
      }
      const agent = agents.find((candidate) => candidate.pid === item.pid);
      if (!agent) {
        console.error(`AI session not found for pid ${item.pid}.`);
        process.exit(1);
      }
      const result = await jumpToAgent(agent);
      printJumpResult(result);
      if (!result.found) process.exit(1);
      return;
    }

    // Default: list mode
    if (opts.json) {
      printAttentionJson(agents, limit);
    } else {
      printAttention(agents, limit);
    }
  });

program
  .command("guard")
  .description("Evaluate Claude hook payload and return allow/block decision")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    try {
      const config = await loadConfig(resolveConfigPath(opts));
      const input = await readStdin();
      const event = parseHookEvent(input);
      if (!event) {
        console.log(JSON.stringify({ decision: "allow" }));
        return;
      }
      const result = evaluateGuard(config, event);
      // Security alert logging is independent of intervention.enabled —
      // always detect and log dangerous_command / secret_access.
      const securityTriggers = detectGuardTriggers(event).filter(
        (t) => t === "dangerous_command" || t === "secret_access",
      );
      if (securityTriggers.length > 0) {
        const { appendAlertLog } = await import("./alerts/index.js");
        const { getConfigDir } = await import("./config/index.js");
        const { join } = await import("node:path");
        const alertsLogPath = join(getConfigDir(), "alerts.log");
        const agentPid = typeof process.ppid === "number" ? process.ppid : 0;
        for (const trigger of securityTriggers) {
          const message =
            trigger === "secret_access"
              ? `Credential file access: ${event.filePath ?? "(unknown)"}`
              : `Dangerous command detected: ${event.command ?? "(unknown)"}`;
          await appendAlertLog(alertsLogPath, {
            id: `security:${agentPid}:${Math.floor(Date.now() / 300_000)}`,
            type: "security",
            severity: "critical",
            agentPid,
            cwd: event.cwd,
            message,
            detail: `tool=${event.toolName ?? "?"} trigger=${trigger}`,
            createdAt: Date.now(),
          });
        }
      }
      console.log(formatGuardOutput(result));
    } catch {
      console.log(JSON.stringify({ decision: "allow" }));
    }
  });

program
  .command("debug-phase")
  .description("Inspect phase signals, stdout heuristic, and tmux capture for one AI session")
  .requiredOption("--pid <pid>", "AI process PID")
  .option("--lines <n>", "Number of tmux pane lines to capture", "40")
  .option("--json", "Output as JSON")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const pid = Number.parseInt(opts.pid, 10);

    if (Number.isNaN(pid)) {
      console.error(`Invalid pid: ${opts.pid}`);
      process.exit(1);
    }

    const lines = Math.max(Number.parseInt(opts.lines, 10) || 40, 10);
    const config = await loadConfig(resolveConfigPath(opts));

    let agents: AgentSession[];
    try {
      agents = await scanAgents(config, {
        enrichmentMode: "full",
        sessionRegistry: await loadSessionRegistry(),
      });
    } catch (error) {
      const payload = {
        found: false,
        pid,
        error: formatProcessFailure(error),
      };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.error(payload.error);
      }
      process.exit(1);
    }

    const agent = agents.find((item) => item.pid === pid);
    if (!agent) {
      const payload = { found: false, pid };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`AI session not found for pid ${pid}.`);
      }
      process.exit(1);
    }

    const tmuxTarget = await resolveTmuxJumpTarget(agent);
    const paneOutput = tmuxTarget ? await captureTmuxPaneOutput(tmuxTarget, lines) : undefined;
    const stdoutPhase =
      agent.runtimeSource === "cli" ? await detectCliStdoutPhase(agent, config) : undefined;

    let sessionPhase: string | undefined;
    let sessionSourceFile: string | undefined;
    let sessionLastActivityAt: number | undefined;
    let sessionLastResponseAt: number | undefined;

    if (agent.agentName === "Gemini") {
      const gemini = await parseGeminiSession(agent.cwd);
      sessionPhase = gemini.phase;
      sessionSourceFile = gemini.sessionFile;
      sessionLastActivityAt = gemini.lastActivityAt;
      sessionLastResponseAt = gemini.lastResponseAt;
    } else if (agent.agentName === "Codex") {
      const { loadCodexBindingRegistryFromFile, selectCodexBindingSession, buildCodexBindingKey } =
        await import("./scanner/codex-binding-registry.js");
      const { getConfigDir } = await import("./config/index.js");
      const { join: pj } = await import("node:path");
      const codexSessions = await indexCodexSessions(config, { activeCwds: [agent.cwd] });
      const bindingRegistry = new Map();
      await loadCodexBindingRegistryFromFile(
        pj(getConfigDir(), "codex-binding-registry.json"),
        bindingRegistry,
      );
      const matched =
        selectCodexBindingSession(
          bindingRegistry,
          agent.pid,
          agent.processStartedAt,
          agent.cwd,
          codexSessions,
        ) ?? matchCodexSession(agent.cwd, agent.processStartedAt, codexSessions);
      sessionPhase = await detectCodexPhase(matched?.filePath, config);
      sessionSourceFile = matched?.filePath;
      sessionLastActivityAt = matched?.lastActivityAt;
    } else if (agent.agentName === "Claude Code" && agent.sessionId) {
      const phaseResult = await detectClaudePhase(
        agent.sessionId,
        agent.cwd,
        agent.startedAt,
        config,
      );
      sessionPhase = phaseResult.phase;
      sessionLastActivityAt = phaseResult.lastActivityAt;
      sessionLastResponseAt = phaseResult.lastResponseAt;
    }

    const payload = {
      found: true,
      pid: agent.pid,
      agent: agent.agentName,
      cwd: agent.cwd,
      runtimeSource: agent.runtimeSource,
      status: agent.status,
      finalPhase: agent.phase ?? null,
      finalLastActivityAt: agent.lastActivityAt ?? null,
      finalLastResponseAt: agent.lastResponseAt ?? null,
      sessionPhase: sessionPhase ?? null,
      sessionSourceFile: sessionSourceFile ?? null,
      sessionLastActivityAt: sessionLastActivityAt ?? null,
      sessionLastResponseAt: sessionLastResponseAt ?? null,
      stdoutPhase: stdoutPhase ?? null,
      tmuxTarget: tmuxTarget
        ? {
            pane: tmuxTarget.pane.target,
            match: tmuxTarget.match,
          }
        : null,
      paneOutput: paneOutput?.trimEnd() ?? null,
      codexBinding: null as null | Record<string, unknown>,
    };

    // Codex binding diagnostics
    if (agent.agentName === "Codex") {
      const { loadCodexBindingRegistryFromFile, buildCodexBindingKey } = await import(
        "./scanner/codex-binding-registry.js"
      );
      const { getConfigDir } = await import("./config/index.js");
      const { join: pj } = await import("node:path");
      const bindingRegistry = new Map();
      await loadCodexBindingRegistryFromFile(
        pj(getConfigDir(), "codex-binding-registry.json"),
        bindingRegistry,
      );
      const binding = bindingRegistry.get(buildCodexBindingKey(agent.pid, agent.processStartedAt));
      if (binding) {
        payload.codexBinding = {
          threadId: binding.threadId,
          rolloutPath: binding.rolloutPath,
          confidence: binding.confidence,
          unstableCount: binding.unstableCount,
          lastVerifiedAt: binding.lastVerifiedAt,
          deadAt: binding.deadAt ?? null,
        };
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`PID: ${payload.pid}`);
    console.log(`Agent: ${payload.agent}`);
    console.log(`CWD: ${payload.cwd}`);
    console.log(`Runtime: ${payload.runtimeSource ?? "unknown"}`);
    console.log(`Status: ${payload.status}`);
    console.log(`Final phase: ${payload.finalPhase ?? "(none)"}`);
    console.log(`Session phase: ${payload.sessionPhase ?? "(none)"}`);
    console.log(`Stdout phase: ${payload.stdoutPhase ?? "(none)"}`);
    console.log(`Session file: ${payload.sessionSourceFile ?? "(none)"}`);
    console.log(
      `tmux target: ${payload.tmuxTarget ? `${payload.tmuxTarget.pane} (${payload.tmuxTarget.match})` : "(none)"}`,
    );
    if (payload.codexBinding) {
      const b = payload.codexBinding;
      console.log(
        `Codex binding: thread=${b.threadId} confidence=${b.confidence} unstable=${b.unstableCount}`,
      );
      console.log(`  rollout: ${b.rolloutPath}`);
    }
    console.log("Pane capture:");
    console.log(payload.paneOutput ?? "(none)");
  });

// "jump" is kept as an alias for backward compatibility (Option+N bindings, scripts).
// --attention maps to attention --interactive, --attention-index and --pid pass through.
program
  .command("jump")
  .description("Alias for 'attention' — jump to an AI session's tmux pane")
  .option("--pid <pid>", "Jump to AI session by PID")
  .option("--attention", "Choose from attention items interactively")
  .option("--attention-index <n>", "Jump to Nth attention item directly")
  .option("--json", "Output as JSON")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    // Translate jump flags to attention flags and re-parse
    const args = ["attention"];
    if (opts.attention) args.push("--interactive");
    if (opts.attentionIndex) args.push("--attention-index", opts.attentionIndex);
    if (opts.pid) args.push("--pid", opts.pid);
    if (opts.json) args.push("--json");
    if (opts.config) args.push("--config", opts.config);
    await program.parseAsync(args, { from: "user" });
  });

program
  .command("jump-back")
  .description("Return to the tmux pane you were in before the last jump")
  .option("--client-tty <tty>", "Override client tty (auto-detected if omitted)")
  .action(async (opts) => {
    const { tmpdir: td } = await import("node:os");
    const { join: pjoin } = await import("node:path");
    const anchorPath = pjoin(td(), "marmonitor", "jump-anchors.json");
    const tty = opts.clientTty ?? (await getClientTty());
    if (!tty) {
      console.error("Cannot detect tmux client. Are you inside tmux?");
      process.exit(1);
    }
    const result = await jumpBack(anchorPath, tty);
    console.log(result.message);
    if (!result.success) process.exit(1);
  });

program
  .command("status-click")
  .description("Internal tmux statusline click handler")
  .argument("[token]", "tmux mouse status range token")
  .option("--client-tty <tty>", "Override client tty (auto-detected if omitted)")
  .action(async (token: string | undefined, opts) => {
    const action = parseStatusClickToken(token);
    if (!action) return;

    if (action.kind === "jump-back") {
      const { tmpdir: td } = await import("node:os");
      const { join: pjoin } = await import("node:path");
      const anchorPath = pjoin(td(), "marmonitor", "jump-anchors.json");
      const tty = opts.clientTty ?? (await getClientTty());
      if (!tty) process.exit(1);
      const result = await jumpBack(anchorPath, tty);
      if (!result.success) process.exit(1);
      return;
    }

    const agents = await getAgentsSnapshot();
    if (agents.length === 0) process.exit(1);
    const agent = findClickedAgent(agents, action);
    if (!agent) process.exit(1);
    const result = await jumpToAgent(agent);
    if (!result.executed) process.exit(1);
  });

program
  .command("dock")
  .description("Compact persistent monitor for tmux pane")
  .option("--interval <sec>", "Refresh interval in seconds", "2")
  .option("--lines <n>", "Max display lines", "12")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const config = await loadConfig(resolveConfigPath(opts));
    applyTerminalStyle(config.integration.tmux.badgeStyle);
    const intervalMs = Math.max(Number(opts.interval) || 2, 2) * 1000;
    const maxLines = Number(opts.lines) || 12;

    let agents = await requireDaemonSnapshot();
    while (true) {
      clearScreen();
      await printDock(agents, maxLines);
      await sleep(intervalMs);
      agents = await getAgentsSnapshot();
      if (agents.length === 0) agents = []; // daemon stopped mid-loop
    }
  });

program
  .command("watch")
  .description("Refresh agent status in a long-lived loop")
  .option("--interval <sec>", "Refresh interval in seconds", "2")
  .option("--json", "Output as JSON")
  .option("--config <path>", "Path to settings.json")
  .action(async (opts) => {
    const config = await loadConfig(resolveConfigPath(opts));
    applyTerminalStyle(config.integration.tmux.badgeStyle);
    const intervalSec = Number(opts.interval);
    const intervalMs = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec * 1000 : 2_000;

    let agents = await requireDaemonSnapshot();
    while (true) {
      clearScreen();
      if (opts.json) {
        await printStatusJson(agents);
      } else {
        await printStatus(agents);
      }
      await sleep(intervalMs);
      agents = await getAgentsSnapshot();
      if (agents.length === 0) agents = []; // daemon stopped mid-loop
    }
  });

program
  .command("activity")
  .description("Show recent tool usage and token activity per session")
  .option("--pid <pid>", "Filter by AI process PID")
  .option("--session <sid>", "Filter by session ID (prefix match)")
  .option("--days <n>", "Number of days to show", "1")
  .option("--lines <n>", "Max activity lines per session (default 30, max 200)", "30")
  .option("--order <dir>", "Sort order: desc (newest first) or asc (oldest first)", "desc")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { getConfigDir } = await import("./config/index.js");
    const { join: pj } = await import("node:path");
    const { getRecentDateKeys, readActivityLog } = await import("./scanner/activity-log.js");

    const logDir = pj(getConfigDir(), "activity-log");
    const days = Math.max(1, Math.min(90, Number(opts.days) || 1));
    const maxLines = Math.max(1, Math.min(200, Number(opts.lines) || 30));
    const descOrder = opts.order !== "asc";
    const allEntries = [];

    for (const dateStr of getRecentDateKeys(days)) {
      const entries = await readActivityLog(logDir, dateStr);
      allEntries.push(...entries);
    }

    // Filter
    let filtered = allEntries;
    let pidFilterAgent:
      | { agentName: string; pid: number; cwd: string; sessionId: string }
      | undefined;
    if (opts.pid) {
      const agents = await getAgentsSnapshot();
      const agent = agents.find((a) => a.pid === Number(opts.pid));
      if (agent?.sessionId) {
        pidFilterAgent = {
          agentName: agent.agentName,
          pid: agent.pid,
          cwd: agent.cwd,
          sessionId: agent.sessionId,
        };
        const sidPrefix = agent.sessionId.slice(0, 12);
        filtered = filtered.filter((e) => e.sid.startsWith(sidPrefix));
      } else {
        pidFilterAgent = agent
          ? { agentName: agent.agentName, pid: agent.pid, cwd: agent.cwd, sessionId: "" }
          : undefined;
        filtered = [];
      }
    }
    if (opts.session) {
      const prefix = opts.session;
      filtered = filtered.filter((e) => e.sid.startsWith(prefix));
    }

    if (opts.json) {
      if (descOrder) filtered.reverse();
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    if (filtered.length === 0) {
      if (pidFilterAgent) {
        console.log(`No activity found for PID ${pidFilterAgent.pid}.`);
        console.log(`  Agent: ${pidFilterAgent.agentName}`);
        console.log(`  CWD:   ${pidFilterAgent.cwd}`);
        if (pidFilterAgent.sessionId) {
          console.log(`  SID:   ${pidFilterAgent.sessionId.slice(0, 12)}...`);
        } else {
          console.log("  SID:   (no session matched — activity logging may not have started)");
        }
        console.log(`\n  Activity log checked: last ${days} day(s) in ${logDir}`);
      } else {
        console.log("No activity found.");
      }
      return;
    }

    // Group by session
    const bySession = new Map();
    for (const e of filtered) {
      const key = `${e.sid}|${e.agent}|${e.cwd}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(e);
    }

    for (const [key, entries] of bySession) {
      const [sid, agent, cwd] = key.split("|");
      const totalOut = entries.reduce(
        (sum: number, e: Record<string, unknown>) =>
          sum + ((e.tokens as Record<string, number>)?.out ?? 0),
        0,
      );
      const totalCache = entries.reduce(
        (sum: number, e: Record<string, unknown>) =>
          sum + ((e.tokens as Record<string, number>)?.cache ?? 0),
        0,
      );
      console.log(`\n${agent}  ${sid}...  ${cwd}`);
      console.log(
        `  ${entries.length} actions  out:${formatTokensShort(totalOut)}  cache:${formatTokensShort(totalCache)}`,
      );
      console.log("  ─────────────────────────────────────");
      const sorted = descOrder ? [...entries].reverse() : entries;
      const shown = sorted.slice(0, maxLines);
      for (const e of shown) {
        const t = new Date(e.ts * 1000).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        });
        console.log(`  ${t}  ${e.tool}: ${truncateForDisplay(e.target, 60)}`);
      }
      if (entries.length > maxLines) {
        console.log(`  ... +${entries.length - maxLines} more (use --lines to show more)`);
      }
    }
  });

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

program
  .command("clean")
  .description("Show or terminate unmatched processes")
  .option("--config <path>", "Path to settings.json")
  .option("--json", "Output as JSON")
  .option("--kill", "Send SIGTERM to selected unmatched processes")
  .option("--pid <pid...>", "Only include specific unmatched PID(s)")
  .action(async (opts) => {
    const config = await loadConfig(resolveConfigPath(opts));
    const agents = await scanAgents(config, { sessionRegistry: await loadSessionRegistry() });
    const selectedPids = Array.isArray(opts.pid)
      ? opts.pid
          .map((value: string) => Number.parseInt(value, 10))
          .filter((value: number) => !Number.isNaN(value))
      : undefined;
    const targets = selectUnmatchedTargets(agents, selectedPids);

    if (opts.kill) {
      for (const target of targets) {
        try {
          process.kill(target.pid, "SIGTERM");
        } catch {
          // keep going; the process may already be gone
        }
      }
    }

    if (opts.json) {
      printCleanJson(targets, Boolean(opts.kill));
    } else {
      printCleanPlan(targets, Boolean(opts.kill));
    }
  });

program
  .command("setup")
  .description("Set up marmonitor integrations")
  .argument("<target>", "Integration target (tmux)")
  .action(async (target: string) => {
    if (target !== "tmux") {
      console.error(`Unknown target: ${target}. Supported: tmux`);
      process.exit(1);
    }
    const { addMarmonitorPlugin, hasMarmonitorPlugin } = await import("./tmux/setup.js");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const confPath = join(homedir(), ".tmux.conf");

    if (await hasMarmonitorPlugin(confPath)) {
      console.log("tmux integration already configured.");
      return;
    }

    await addMarmonitorPlugin(confPath);
    console.log("✓ Added marmonitor-tmux plugin to ~/.tmux.conf");
    console.log("Press prefix+I inside tmux to activate.");

    // Start daemon if not already running
    await startDaemon();
  });

program
  .command("update-integration")
  .description("Check how to sync the installed tmux integration")
  .option("--quiet", "Suppress non-essential output")
  .action(async (opts: { quiet?: boolean }) => {
    const { detectTmuxIntegrationMode, getMarmonitorPluginDir } = await import("./tmux/setup.js");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const confPath = join(homedir(), ".tmux.conf");
    const pluginDir = getMarmonitorPluginDir();
    const mode = await detectTmuxIntegrationMode(confPath, pluginDir);

    if (mode === "local") {
      if (!opts.quiet) {
        console.log("Local marmonitor-tmux run-shell detected.");
        console.log("Your local repo changes are already active after tmux reload.");
      }
      return;
    }

    if (!mode) {
      if (!opts.quiet) {
        console.log("tmux integration is not configured. Run: marmonitor setup tmux");
      }
      return;
    }

    if (mode === "missing") {
      if (!opts.quiet) {
        console.log("tmux integration is configured, but marmonitor-tmux is not installed yet.");
        console.log("Press prefix+I in tmux to install the plugin.");
      }
      return;
    }

    if (mode === "not_git") {
      if (!opts.quiet) {
        console.log("marmonitor-tmux exists but is not a git checkout.");
        console.log(`Reinstall the plugin or update it manually: ${pluginDir}`);
      }
      return;
    }

    if (!opts.quiet) {
      console.log("marmonitor-tmux TPM plugin detected.");
      console.log("Update path:");
      console.log("  1. Press prefix+U in tmux");
      console.log(`  2. Or run: git -C ${pluginDir} pull --ff-only`);
      console.log(
        `  3. Re-apply the plugin in the running tmux server: tmux run-shell ${join(pluginDir, "marmonitor.tmux")}`,
      );
      console.log("  4. If the status bar still looks stale, reload tmux.conf or restart tmux");
    }
  });

program
  .command("uninstall-integration")
  .description("Remove marmonitor settings from tmux.conf")
  .action(async () => {
    const { removeMarmonitorPlugin } = await import("./tmux/setup.js");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const confPath = join(homedir(), ".tmux.conf");

    const removed = await removeMarmonitorPlugin(confPath);
    if (removed) {
      console.log("✓ Removed marmonitor-tmux plugin from ~/.tmux.conf");
    } else {
      console.log("No marmonitor settings found in ~/.tmux.conf");
    }

    // Stop daemon
    await stopDaemon();

    // Restore tmux memory state (status bar → 1 line, remove status-format[1])
    try {
      const { execFile: ef } = await import("node:child_process");
      const { promisify: p } = await import("node:util");
      const exec = p(ef);
      await exec("tmux", ["set", "-g", "status", "on"]);
      await exec("tmux", ["set", "-gu", "status-format[1]"]);
      console.log("✓ Restored tmux status bar to single line");
    } catch {
      console.log("  tmux not running — restart tmux to apply changes");
    }

    console.log("\nTo complete removal:");
    console.log("  $ npm uninstall -g marmonitor");
    console.log("\nOptional cleanup:");
    console.log("  $ rm -rf ~/.config/marmonitor    # settings & session history");
    console.log("  $ rm -rf ~/.tmux/plugins/marmonitor-tmux  # tpm plugin");
  });

/** Find all running marmonitor daemon PIDs (excludes current CLI process) */
async function findRunningDaemonPids(): Promise<number[]> {
  try {
    const { default: psList } = await import("ps-list");
    const procs = await psList();
    return procs.filter((p) => p.name === "marmonitor" && p.pid !== process.pid).map((p) => p.pid);
  } catch {
    return [];
  }
}

async function startDaemon(): Promise<number | undefined> {
  const running = await findRunningDaemonPids();
  if (running.length > 0) {
    console.log(`Daemon already running (PID: ${running[0]})`);
    return undefined;
  }
  const { fork } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const child = fork(join(here, "..", "bin", "daemon.js"), [], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`✓ Daemon started (PID: ${child.pid})`);
  return child.pid ?? undefined;
}

async function stopDaemon(): Promise<boolean> {
  const pids = await findRunningDaemonPids();
  if (pids.length === 0) {
    console.log("Daemon is not running.");
    return false;
  }
  // Send SIGTERM to all running daemon processes (handles orphans)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  // Poll until all processes die (up to 2s)
  let remaining = [...pids];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    remaining = remaining.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true; // still alive
      } catch {
        return false; // dead
      }
    });
    if (remaining.length === 0) break;
  }
  // Fallback: SIGKILL any survivors
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  console.log(`✓ Daemon stopped (PID: ${pids.join(", ")})`);
  return true;
}

program
  .command("start")
  .description("Start background scan daemon")
  .action(async () => {
    await startDaemon();
    process.exit(0);
  });

program
  .command("stop")
  .description("Stop background scan daemon")
  .action(async () => {
    await stopDaemon();
    process.exit(0);
  });

program
  .command("restart")
  .description("Restart background scan daemon")
  .action(async () => {
    await stopDaemon();
    await startDaemon();
    process.exit(0);
  });

installProcessSafetyHandlers();
program.parse();

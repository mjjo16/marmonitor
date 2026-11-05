import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefaults } from "../dist/config/index.js";
import { detectAgentFromProcessSignature } from "../dist/scanner/process.js";

const config = getDefaults();

describe("CLI process identity (MJ-MAR-0002)", () => {
  const excluded = [
    [
      "browser_crashpad_handler",
      "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler --monitor-self",
    ],
    [
      "SkyComputerUseService",
      "/Users/me/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
    ],
    ["Claude", "/Applications/Claude.app/Contents/MacOS/Claude"],
    ["Codex", "/Applications/Codex.app/Contents/MacOS/Codex"],
    [
      "codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c forced_login_method=chatgpt exec-server --remote example",
    ],
    ["codex", "/usr/bin/codex --config model=example app-server"],
    ["node", "/usr/bin/node /usr/local/bin/codex exec-server"],
    ["node", "/usr/bin/node /usr/local/lib/node_modules/@openai/codex/bin/codex.js app-server"],
    ["node", "/usr/bin/node /tmp/other.js /usr/local/bin/codex"],
    ["bash", "/bin/bash -c /usr/local/bin/codex"],
    ["sleep", "/usr/bin/sleep /tmp/claude"],
    ["node", '/usr/bin/node "/tmp/codex Framework/helper.js"'],
  ];
  for (const [name, cmd] of excluded) {
    it(`excludes ${cmd}`, () => {
      assert.equal(detectAgentFromProcessSignature({ name, cmd }, config), null);
    });
  }

  const included = [
    ["codex", "/usr/local/bin/codex", "Codex"],
    ["codex", "/Users/me/My Tools/bin/codex --model example", "Codex"],
    ["codex", "/usr/bin/codex 'explain app-server and exec-server'", "Codex"],
    ["codex", "/usr/bin/codex exec 'fix app-server'", "Codex"],
    ["codex", "/usr/bin/codex --config note=app-server resume old-thread", "Codex"],
    ["codex", "/usr/bin/codex -- app-server", "Codex"],
    ["claude", "/usr/local/bin/claude --prompt 'explain --type=renderer'", "Claude Code"],
    ["node", "/usr/bin/node /usr/local/bin/claude", "Claude Code"],
    [
      "node",
      "/usr/bin/node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "Claude Code",
    ],
    [
      "node",
      "/usr/bin/node --max-old-space-size=4096 /usr/local/lib/node_modules/@openai/codex/bin/codex.js resume old-thread",
      "Codex",
    ],
    ["node", '/usr/bin/node "/Users/me/My Tools/bin/gemini" chat', "Gemini"],
    [
      "node",
      "/usr/bin/node /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js",
      "Gemini",
    ],
  ];
  for (const [name, cmd, expected] of included) {
    it(`preserves ${cmd}`, () => {
      assert.equal(detectAgentFromProcessSignature({ name, cmd }, config), expected);
    });
  }

  it("excludes sandbox runtimes even when cwd and binary match a live CLI", () => {
    for (const runtime of ["kernel.js", "trusted-worker.js"]) {
      assert.equal(
        detectAgentFromProcessSignature(
          {
            name: "codex",
            cmd: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex sandbox -c default_permissions=node_repl -- /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node /tmp/${runtime}`,
          },
          config,
        ),
        null,
      );
    }
  });

  it("excludes utility modes without suppressing prompts that mention them", () => {
    for (const mode of [
      "sandbox",
      "debug",
      "mcp",
      "mcp-server",
      "login",
      "logout",
      "completion",
      "apply",
      "cloud",
      "features",
      "help",
      "--help",
      "--version",
    ]) {
      assert.equal(
        detectAgentFromProcessSignature({ name: "codex", cmd: `/usr/bin/codex ${mode}` }, config),
        null,
        mode,
      );
      assert.equal(
        detectAgentFromProcessSignature(
          { name: "codex", cmd: `/usr/bin/codex exec 'explain ${mode}'` },
          config,
        ),
        "Codex",
        mode,
      );
    }
  });

  it("preserves session modes, sandbox policy options and ordinary prompt words", () => {
    for (const args of [
      "exec task",
      "e task",
      "review",
      "resume old-thread",
      "fork old-thread",
      "--sandbox read-only 'explain sandbox'",
      "--remote unix:///tmp/codex.sock resume old-thread",
      "-- sandbox",
      "constructor",
      "toString",
    ]) {
      assert.equal(
        detectAgentFromProcessSignature({ name: "codex", cmd: `/usr/bin/codex ${args}` }, config),
        "Codex",
        args,
      );
    }
  });
});

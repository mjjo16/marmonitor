/**
 * Cross-platform clipboard writer with fallback chain.
 *
 * macOS  : pbcopy
 * Linux  : wl-copy → xclip → xsel  (in that order)
 *
 * Throws ClipboardError with a human-readable reason when all commands fail.
 */

import { spawn } from "node:child_process";

interface ClipboardCommand {
  command: string;
  args: string[];
}

export class ClipboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipboardError";
  }
}

function commandsForPlatform(): ClipboardCommand[] {
  if (process.platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

async function tryRun(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => done(false));
      child.on("close", (code) => done(code === 0));
      child.stdin.on("error", () => done(false));
      child.stdin.end(text);
    } catch {
      done(false);
    }
  });
}

export async function writeClipboard(text: string): Promise<void> {
  const candidates = commandsForPlatform();
  const tried: string[] = [];
  for (const { command, args } of candidates) {
    tried.push(command);
    if (await tryRun(command, args, text)) return;
  }
  throw new ClipboardError(
    `Clipboard copy failed (tried: ${tried.join(", ")}). Try --stdout to print instead.`,
  );
}

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
const INSTALL_BANNER_ASSET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "banner-combined.png",
);
const RUNTIME_BANNER_ASSET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "docs",
  "banner-brown-dots-small.png",
);

const ANSI_MARMOT_PALETTE: Record<string, [number, number, number]> = {
  "1": [194, 154, 115],
  "2": [145, 103, 69],
  "3": [103, 66, 41],
  "4": [1, 0, 0],
};
const TEXT_LOGO_PRIMARY: [number, number, number] = [145, 103, 69];
const TEXT_LOGO_SHADOW: [number, number, number] = [103, 66, 41];
const GLYPH_HEIGHT = 7;
const PIXEL_FONT: Record<string, readonly string[]> = {
  M: ["1   1", "11 11", "1 1 1", "1   1", "1   1", "1   1", "1   1"],
  A: [" 111 ", "1   1", "1   1", "11111", "1   1", "1   1", "1   1"],
  R: ["1111 ", "1   1", "1   1", "1111 ", "1 1  ", "1  1 ", "1   1"],
  O: [" 111 ", "1   1", "1   1", "1   1", "1   1", "1   1", " 111 "],
  N: ["1   1", "11  1", "1 1 1", "1  11", "1   1", "1   1", "1   1"],
  I: ["11111", "  1  ", "  1  ", "  1  ", "  1  ", "  1  ", "11111"],
  T: ["11111", "  1  ", "  1  ", "  1  ", "  1  ", "  1  ", "  1  "],
};

const ANSI_MARMOT_ROWS = [
  "       22221",
  "      22 223",
  "     2222223",
  "     2112222",
  "     211333 ",
  "    3211222 ",
  "   322111112",
  "   332111111",
  "  3321111111",
  "  3332111122",
  "  3323221123",
  "  3322211112",
  "   332221113",
  "  4232221112",
  "322233221113",
  "332 33223333",
] as const;

function fg(color: [number, number, number]): string {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
}

function bg(color: [number, number, number]): string {
  return `\x1b[48;2;${color[0]};${color[1]};${color[2]}m`;
}

function renderAnsiMarmot(): string {
  const lines: string[] = [];

  for (let y = 0; y < ANSI_MARMOT_ROWS.length; y += 2) {
    const top = ANSI_MARMOT_ROWS[y] ?? "";
    const bottom = ANSI_MARMOT_ROWS[y + 1] ?? "";
    let line = "";
    const width = Math.max(top.length, bottom.length);

    for (let x = 0; x < width; x += 1) {
      const topChar = top[x] ?? " ";
      const bottomChar = bottom[x] ?? " ";
      const topColor = ANSI_MARMOT_PALETTE[topChar];
      const bottomColor = ANSI_MARMOT_PALETTE[bottomChar];

      if (!topColor && !bottomColor) {
        line += " ";
        continue;
      }
      if (topColor && bottomColor) {
        line += `${fg(topColor)}${bg(bottomColor)}▀\x1b[0m`;
        continue;
      }
      if (topColor) {
        line += `${fg(topColor)}▀\x1b[0m`;
        continue;
      }
      line += `${fg(bottomColor as [number, number, number])}▄\x1b[0m`;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

function colorizeTextLogoLine(line: string): string {
  let result = "";
  for (const ch of line) {
    if (ch === "1") {
      result += `${fg(TEXT_LOGO_PRIMARY)}█\x1b[0m`;
      continue;
    }
    if (ch === "2") {
      result += `${fg(TEXT_LOGO_SHADOW)}█\x1b[0m`;
      continue;
    }
    result += " ";
  }
  return result;
}

function buildPixelWordmark(word: string): string[] {
  const rows = Array.from({ length: GLYPH_HEIGHT }, () => "");

  for (const character of word) {
    const glyph = PIXEL_FONT[character];
    if (!glyph) continue;
    for (let rowIndex = 0; rowIndex < GLYPH_HEIGHT; rowIndex += 1) {
      rows[rowIndex] += glyph[rowIndex];
      rows[rowIndex] += " ";
    }
  }

  return rows.map((row) => row.trimEnd());
}

function stretchWordmarkRows(rows: string[]): string[] {
  if (rows.length < 5) return rows;

  return [rows[0], rows[1], rows[2], rows[2], rows[3], rows[4], rows[5], rows[6]];
}

function buildTextLogoRows(): string[] {
  return stretchWordmarkRows(buildPixelWordmark("MARMONITOR")).map(colorizeTextLogoLine);
}

function renderRuntimeMark(): string {
  return `${fg(TEXT_LOGO_SHADOW)}▚${fg(TEXT_LOGO_PRIMARY)}▞\x1b[0m`;
}

function renderAnsiInstallFallback(): string {
  const marmotLines = renderAnsiMarmot().split("\n");
  const logoLines = buildTextLogoRows();
  const totalLines = marmotLines.length;
  const visibleLogoLines =
    logoLines.length > totalLines ? logoLines.slice(0, totalLines) : logoLines;
  const logoTop = Math.max(0, Math.floor((totalLines - visibleLogoLines.length) / 2));

  return Array.from({ length: totalLines }, (_, index) => {
    const marmotLine = marmotLines[index] ?? "";
    const logoIndex = index - logoTop;
    const logoLine =
      logoIndex >= 0 && logoIndex < visibleLogoLines.length ? visibleLogoLines[logoIndex] : "";
    return logoLine ? `${marmotLine}   ${logoLine}` : marmotLine;
  }).join("\n");
}

function readInlineBannerImage(): string | undefined {
  if (!existsSync(INSTALL_BANNER_ASSET_PATH)) return undefined;
  try {
    return readFileSync(INSTALL_BANNER_ASSET_PATH).toString("base64");
  } catch {
    return undefined;
  }
}

export function supportsInlineBannerImage(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "iTerm.app" || Boolean(env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE);
}

function renderWeztermInlineImage(width: string, assetPath: string): string | undefined {
  if (!existsSync(assetPath)) return undefined;
  try {
    const weztermExecutable = process.env.WEZTERM_EXECUTABLE || "wezterm";
    return execFileSync(
      weztermExecutable,
      ["imgcat", "--width", width, "--tmux-passthru", "detect", assetPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return undefined;
  }
}

function renderBestEffortImage(
  width: string,
  assetPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE || env.TERM_PROGRAM === "WezTerm") {
    return renderWeztermInlineImage(width, assetPath);
  }

  if (env.TERM_PROGRAM === "iTerm.app") {
    if (assetPath !== INSTALL_BANNER_ASSET_PATH) return undefined;
    const imageData = readInlineBannerImage();
    if (!imageData) return undefined;
    return width === "32"
      ? `\u001b]1337;File=inline=1;width=32:${imageData}\u0007`
      : `\u001b]1337;File=inline=1;preserveAspectRatio=1:${imageData}\u0007`;
  }

  return undefined;
}

export function renderInstallInfo(): string {
  return [
    `marmonitor v${VERSION}`,
    "Standing guard over your AI sessions",
    "",
    "Get started:",
    "  $ marmonitor status        - Show active AI sessions",
    "  $ marmonitor attention     - Focus sessions that need review",
    "  $ marmonitor watch         - Live full-screen monitor",
    "  $ marmonitor dock          - Persistent tmux monitor",
    "  $ marmonitor --statusline  - tmux statusbar widget",
    "  $ marmonitor help          - Commands, shortcuts, integration tips",
    "",
    "tmux defaults:",
    "  Prefix+a attention popup  |  Prefix+j jump popup  |  Prefix+m dock",
    "  Option+1..5 direct jump to top attention sessions",
    "",
    "Docs: https://github.com/mjjo16/marmonitor",
  ].join("\n");
}

export function renderRuntimeInfo(activeSessions?: number): string {
  const sessionText =
    typeof activeSessions === "number"
      ? `${activeSessions} active session${activeSessions === 1 ? "" : "s"}`
      : "local AI agent monitor";
  return `marmonitor v${VERSION}\nMonitoring: Claude Code, Codex${activeSessions !== undefined ? `  |  ${sessionText}` : ""}`;
}

export function renderInstallBanner(env: NodeJS.ProcessEnv = process.env): string {
  const bannerImage =
    renderBestEffortImage("50%", INSTALL_BANNER_ASSET_PATH, env) ?? renderAnsiInstallFallback();
  return `${bannerImage}\n\n${renderInstallInfo()}`;
}

export function renderRuntimeBanner(
  activeSessions?: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bannerImage =
    renderBestEffortImage("12", RUNTIME_BANNER_ASSET_PATH, env) ?? renderRuntimeMark();
  return `${bannerImage} ${renderRuntimeInfo(activeSessions)}`;
}

export const BANNER = renderInstallBanner();
export const BANNER_SMALL = renderRuntimeBanner();

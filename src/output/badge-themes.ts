/**
 * Badge theme definitions for tmux statusline rendering.
 * Each theme defines template strings with placeholders:
 *   {label}, {fg}, {bg} for badges
 *   {index}, {label}, {bg} for attention segments
 *   {text} for focus text
 */

export interface BadgeTheme {
  badge: string;
  attention: string;
  focus: string;
  empty: string;
  jumpBack: string;
}

export const BADGE_THEMES: Record<string, BadgeTheme> = {
  basic: {
    badge: "#[fg={bg},bg=#1e1e2e]#[bold,fg={fg},bg={bg}] {label} #[fg={bg},bg=#1e1e2e]#[default]",
    attention:
      "#[fg={bg},bg=#1e1e2e]#[bold,fg=#11111b,bg={bg}] {index} #[fg=#313244,bg={bg}]#[fg=#cdd6f4,bg=#313244] {label} #[fg=#313244,bg=#1e1e2e]#[default]",
    focus: "#[fg=#bac2de,bg=#181825] {text} #[default]",
    empty: "#[fg=#cdd6f4,bg=#313244] no active #[fg=#313244,bg=#1e1e2e]#[default]",
    jumpBack:
      "#[fg=#45475a,bg=#1e1e2e]#[fg=#bac2de,bg=#45475a] ↩ #[fg=#45475a,bg=#1e1e2e]#[default]",
  },
  "basic-mono": {
    badge:
      "#[fg=#313244,bg=#1e1e2e]#[bold,fg=#cdd6f4,bg=#313244] {label} #[fg=#313244,bg=#1e1e2e]#[default]",
    attention:
      "#[fg=#313244,bg=#1e1e2e]#[bold,fg=#cdd6f4,bg=#313244] {index} #[fg=#1e1e2e,bg=#313244]#[fg=#6c7086,bg=#1e1e2e] {label} #[fg=#1e1e2e]#[default]",
    focus: "#[fg=#6c7086,bg=#181825] {text} #[default]",
    empty:
      "#[fg=#313244,bg=#1e1e2e]#[fg=#6c7086,bg=#313244] no active #[fg=#313244,bg=#1e1e2e]#[default]",
    jumpBack:
      "#[fg=#313244,bg=#1e1e2e]#[fg=#6c7086,bg=#313244] ↩ #[fg=#313244,bg=#1e1e2e]#[default]",
  },
  block: {
    badge: "#[bold,fg={fg},bg={bg}] {label} #[default]",
    attention: "#[bold,fg=#11111b,bg={bg}] {index} #[fg=#cdd6f4,bg=#313244] {label} #[default]",
    focus: "#[fg=#bac2de,bg=#181825] {text} #[default]",
    empty: "#[fg=#cdd6f4,bg=#313244] no active #[default]",
    jumpBack: "#[fg=#bac2de,bg=#45475a] ↩ #[default]",
  },
  "block-mono": {
    badge: "#[bold,fg=#cdd6f4,bg=#313244] {label} #[default]",
    attention: "#[bold,fg=#cdd6f4,bg=#313244] {index} #[fg=#6c7086,bg=#1e1e2e] {label} #[default]",
    focus: "#[fg=#6c7086,bg=#181825] {text} #[default]",
    empty: "#[fg=#6c7086,bg=#313244] no active #[default]",
    jumpBack: "#[fg=#6c7086,bg=#313244] ↩ #[default]",
  },
  text: {
    badge: "#[fg={bg}]{label}#[default]",
    attention: "#[fg={bg}]{index} {label}#[default]",
    focus: "{text}",
    empty: "no active",
    jumpBack: "#[fg=#89b4fa]↩#[default]",
  },
  "text-mono": {
    badge: "#[fg=#cdd6f4]{label}#[default]",
    attention: "#[bold,fg=#cdd6f4]{index}#[default] #[fg=#6c7086]{label}#[default]",
    focus: "#[fg=#6c7086]{text}#[default]",
    empty: "#[fg=#6c7086]no active#[default]",
    jumpBack: "#[fg=#6c7086]↩#[default]",
  },
};

export function renderBadge(theme: BadgeTheme, label: string, fg: string, bg: string): string {
  return theme.badge.replaceAll("{label}", label).replaceAll("{fg}", fg).replaceAll("{bg}", bg);
}

export function renderAttention(
  theme: BadgeTheme,
  index: number,
  label: string,
  bg: string,
): string {
  return theme.attention
    .replaceAll("{index}", String(index))
    .replaceAll("{label}", label)
    .replaceAll("{bg}", bg);
}

export function renderFocus(theme: BadgeTheme, text: string): string {
  return theme.focus.replaceAll("{text}", text);
}

export function resolveTheme(style: string): BadgeTheme {
  return BADGE_THEMES[style] ?? BADGE_THEMES.basic;
}

export const TERMINAL_RESTORE_SEQUENCE = "\x1b[0m\x1b[?25h\x1b[?1049l";

export function formatProcessFailure(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? reason.message;
  }
  return String(reason);
}

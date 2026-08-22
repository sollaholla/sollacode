/** Default window the orchestrator is given when it reads a terminal. */
export const DEFAULT_TERMINAL_READ_CHARS = 8_000;

/** Tail included on `list_terminals` so one call is enough to recognize a pane. */
export const DEFAULT_TERMINAL_LIST_PREVIEW_CHARS = 1_200;

const CSI_OR_OSC =
  // CSI / private-mode sequences, OSC ... BEL or ST, and two-byte ESC sequences.
  /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip ANSI and leftover C0 controls so a TUI buffer is readable as text.
 * Carriage-return overwrites become newlines; huge blank runs collapse.
 */
export function visibleTerminalText(
  raw: string,
  maxChars: number = DEFAULT_TERMINAL_READ_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  let text = raw.replace(CSI_OR_OSC, "");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(OTHER_CONTROLS, "");
  text = text.replace(/\n{4,}/g, "\n\n\n");
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(text.length - maxChars), truncated: true };
}

/**
 * Bytes to send to a PTY. `submit` types Enter unless the text already ends
 * with a line terminator — the same gesture as hitting return in the pane.
 */
export function encodeTerminalWrite(text: string, submit: boolean): string {
  if (text.length === 0) {
    return submit ? "\r" : "";
  }
  if (!submit) {
    return text;
  }
  if (text.endsWith("\r") || text.endsWith("\n")) {
    return text;
  }
  return `${text}\r`;
}

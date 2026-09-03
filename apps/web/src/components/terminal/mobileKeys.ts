/**
 * The keys a phone keyboard cannot send.
 *
 * The iOS keyboard has no Control, no Escape, no Tab and no arrows, so a
 * terminal on a phone can type a command but cannot interrupt one, complete a
 * path, recall the last line, or answer a TUI prompt. These are the sequences a
 * physical keyboard would produce, sent straight to the PTY.
 */

export type TerminalMobileKey = {
  /** Stable id, also the test hook. */
  readonly id: string;
  /** Short face label. */
  readonly label: string;
  /** Spoken name for assistive tech and the button title. */
  readonly title: string;
  /** Bytes to write to the PTY, or `paste` for the clipboard. */
  readonly data: string | { readonly clipboard: true };
  /** Grouped so the row can breathe on narrow screens. */
  readonly group: "control" | "motion" | "edit" | "digit";
};

/** ESC as a lone byte; shells and TUIs both read it as Escape. */
const ESC = "\u001B";

export const TERMINAL_MOBILE_KEYS: readonly TerminalMobileKey[] = [
  { id: "escape", label: "esc", title: "Escape", data: ESC, group: "control" },
  { id: "tab", label: "tab", title: "Tab (complete)", data: "\u0009", group: "control" },
  {
    id: "ctrl-c",
    label: "^C",
    title: "Control-C (interrupt)",
    data: "\u0003",
    group: "control",
  },
  {
    id: "ctrl-d",
    label: "^D",
    title: "Control-D (end of input)",
    data: "\u0004",
    group: "control",
  },
  { id: "ctrl-z", label: "^Z", title: "Control-Z (suspend)", data: "\u001A", group: "control" },
  {
    id: "ctrl-l",
    label: "^L",
    title: "Control-L (clear screen)",
    data: "\u000C",
    group: "control",
  },
  { id: "up", label: "↑", title: "Up (previous command)", data: `${ESC}[A`, group: "motion" },
  { id: "down", label: "↓", title: "Down (next command)", data: `${ESC}[B`, group: "motion" },
  { id: "left", label: "←", title: "Left", data: `${ESC}[D`, group: "motion" },
  { id: "right", label: "→", title: "Right", data: `${ESC}[C`, group: "motion" },
  // Readline's own line motions, which is what Home/End mean at a shell prompt.
  { id: "line-start", label: "⇤", title: "Start of line", data: "\u0001", group: "motion" },
  { id: "line-end", label: "⇥", title: "End of line", data: "\u0005", group: "motion" },
  {
    id: "paste",
    label: "paste",
    title: "Paste from clipboard",
    data: { clipboard: true },
    group: "edit",
  },
  // A TUI that asks you to pick option 2 is two taps away on a phone: the
  // digits live behind the keyboard's 123 layer, and switching back afterwards
  // is a third. One tap each instead.
  ...Array.from({ length: 10 }, (_, index) => {
    const digit = String((index + 1) % 10);
    return {
      id: `digit-${digit}`,
      label: digit,
      title: `Digit ${digit}`,
      data: digit,
      group: "digit" as const,
    };
  }),
];

/**
 * Bracketed paste, so a multi-line paste reaches the shell as text rather than
 * as a run of Enter presses that each execute half a command. Programs that did
 * not ask for bracketed paste ignore the markers.
 */
export function bracketedPaste(text: string): string {
  return `${ESC}[200~${text}${ESC}[201~`;
}

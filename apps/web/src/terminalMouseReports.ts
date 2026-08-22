/**
 * xterm only emits mouse/focus report sequences as input when it believes the
 * running program enabled tracking — but replayed bytes from a shared PTY can
 * leave tracking latched on after that program is gone, and then every cursor
 * move types reports like `35;48;1M` into the shell. Local mode resets close
 * most of that window, but the summary they depend on races attach, so the
 * write path additionally strips report payloads whenever no subprocess is in
 * the foreground: a bare shell never wants them.
 */
const TERMINAL_MOUSE_REPORT_PATTERN =
  // SGR (1006) reports, legacy X10/VT200 (`ESC [ M` + 3 bytes), URXVT (1015)
  // numeric reports, and focus-tracking (1004) in/out events.
  // eslint-disable-next-line no-control-regex
  /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\d+;\d+;\d+M|\x1b\[[IO]/g;

export function stripTerminalMouseReports(data: string): string {
  return data.replace(TERMINAL_MOUSE_REPORT_PATTERN, "");
}

// Tracking mode 1003 emits a report for every pointer move, even when no
// button is held. Those reports are not actionable terminal input, and two
// attached clients can otherwise saturate the renderer and WebSocket with
// them. Preserve clicks, releases, drags, wheel events, and focus reports.
// eslint-disable-next-line no-control-regex
const TERMINAL_SGR_MOUSE_REPORT_PATTERN = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
// eslint-disable-next-line no-control-regex
const TERMINAL_X10_MOUSE_REPORT_PATTERN = /\x1b\[M([\s\S])([\s\S])([\s\S])/g;
// eslint-disable-next-line no-control-regex
const TERMINAL_URXVT_MOUSE_REPORT_PATTERN = /\x1b\[(\d+);\d+;\d+M/g;

function isUnbuttonedMouseMotion(buttonCode: number): boolean {
  return (buttonCode & 32) !== 0 && (buttonCode & 3) === 3;
}

export function stripTerminalUnbuttonedMouseMotionReports(data: string): string {
  return data
    .replace(TERMINAL_SGR_MOUSE_REPORT_PATTERN, (report, rawButtonCode: string) =>
      isUnbuttonedMouseMotion(Number(rawButtonCode)) ? "" : report,
    )
    .replace(TERMINAL_X10_MOUSE_REPORT_PATTERN, (report, rawButtonCode: string) => {
      const buttonCode = rawButtonCode.codePointAt(0);
      return buttonCode !== undefined && isUnbuttonedMouseMotion(buttonCode - 32) ? "" : report;
    })
    .replace(TERMINAL_URXVT_MOUSE_REPORT_PATTERN, (report, rawButtonCode: string) =>
      isUnbuttonedMouseMotion(Number(rawButtonCode)) ? "" : report,
    );
}
